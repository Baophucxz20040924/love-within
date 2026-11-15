import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface ModalOptions {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

interface ModalEntry {
  dialog: HTMLElement;
  overlay: HTMLElement;
  previous: HTMLElement | null;
  initialFocus: () => HTMLElement | null;
  close: () => void;
  changed: (topmost: boolean) => void;
  zIndex: string;
  order: number;
}

const stack: ModalEntry[] = [];
let nextOrder = 0;
const inertBefore = new Map<HTMLElement, boolean>();
let overflowBefore = '';
let overflowPriority = '';
let observer: MutationObserver | undefined;
let privacyPaused = false;
/** Pause the modal focus trap while private content is being reauthorized. */
export function setModalPrivacyPause(paused: boolean): void {
  if (privacyPaused === paused) return;
  privacyPaused = paused;
  if (paused) restoreInert();
  else {
    syncStack();
    const top = stack[stack.length - 1];
    if (top) focusInside(top);
  }
}
const focusableSelector = 'a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable="true"], [tabindex]';

function visible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || !element.getClientRects().length) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).opacity === '0') return false;
  }
  return true;
}

function candidates(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]') && visible(element))
    // Respect positive tabindex without introducing one ourselves.
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

function focusInside(entry: ModalEntry, initial = false) {
  const preferred = initial ? entry.initialFocus() : null;
  const target = preferred && entry.dialog.contains(preferred) && visible(preferred) && !preferred.matches(':disabled')
    ? preferred : initial ? entry.dialog : candidates(entry.dialog)[0] ?? entry.dialog;
  target.focus({ preventScroll: true });
}

function restoreInert() {
  inertBefore.forEach((value, node) => { node.inert = value; });
  inertBefore.clear();
}

function syncInert() {
  restoreInert();
  const top = stack[stack.length - 1];
  if (!top || privacyPaused) return;
  // Walk the active portal's ancestor path: never inert its own portal host,
  // even when another modal's portal or app root contains that host.
  let branch: HTMLElement = top.overlay;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertBefore.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    if (parent === document.body) break;
    branch = parent;
  }
}

function syncStack() {
  // Opening order is captured during render (parent before child), not in
  // layout effects (child before parent). A later-opened overlay always wins.
  stack.sort((a, b) => a.order - b.order);
  stack.forEach((entry, index) => {
    entry.overlay.style.zIndex = String(1000 + index * 2);
    entry.changed(index === stack.length - 1);
  });
  syncInert();
}

function onKeyDown(event: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top || privacyPaused || event.isComposing) return;
  // An open inline picker consumes Escape before the enclosing dialog closes.
  if (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.getAttribute('aria-expanded') === 'true') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    top.close();
  } else if (event.key === 'Tab') {
    const nodes = candidates(top.dialog);
    const active = document.activeElement;
    const index = nodes.indexOf(active as HTMLElement);
    if (!nodes.length || index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === nodes.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? nodes[nodes.length - 1] : nodes[0])?.focus({ preventScroll: true });
      if (!nodes.length) top.dialog.focus({ preventScroll: true });
    }
  }
}

function onFocusIn(event: FocusEvent) {
  const top = stack[stack.length - 1];
  if (!privacyPaused && top && event.target instanceof Node && !top.dialog.contains(event.target)) focusInside(top);
}

function register(entry: ModalEntry) {
  if (!stack.length) {
    overflowBefore = document.body.style.getPropertyValue('overflow');
    overflowPriority = document.body.style.getPropertyPriority('overflow');
    document.body.style.setProperty('overflow', 'hidden');
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    observer = new MutationObserver(syncInert);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  const higher = stack.filter((other) => other.order > entry.order).sort((a, b) => a.order - b.order)[0];
  if (higher) {
    // Simultaneous parent/child mount: child focused first, but its close
    // should return into the parent, and the parent back to the page trigger.
    entry.previous = higher.previous;
    higher.previous = entry.dialog;
  }
  stack.push(entry);
  syncStack();
  if (!privacyPaused && entry === stack[stack.length - 1]) focusInside(entry, true);
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return;
    const wasTop = index === stack.length - 1;
    // If a lower modal disappears first, descendants must restore to its
    // original trigger, not to a soon-to-be detached control in that modal.
    for (const other of stack.slice(index + 1)) {
      if (other.previous && entry.overlay.contains(other.previous)) other.previous = entry.previous;
    }
    stack.splice(index, 1);
    entry.overlay.style.zIndex = entry.zIndex;
    syncStack();
    if (!stack.length) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      if (overflowBefore) document.body.style.setProperty('overflow', overflowBefore, overflowPriority);
      else document.body.style.removeProperty('overflow');
    }
    if (wasTop && !privacyPaused) {
      const top = stack[stack.length - 1];
      const previous = entry.previous;
      if (previous?.isConnected && visible(previous) && !previous.matches(':disabled') && (!top || top.dialog.contains(previous))) {
        previous.focus({ preventScroll: true });
      } else if (top) focusInside(top);
    }
  };
}

/**
 * Shared modal lifecycle. Portal the overlay to document.body, attach overlayRef
 * to its root and dialogRef to a role="dialog", tabIndex={-1} container. When the
 * dialog is itself the portal root, overlayRef may be omitted. Use requestClose
 * for close/backdrop buttons; custom keys should be gated with isTopmost.
 */
export function useModal({ open, onClose, busy = false, initialFocusRef }: ModalOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<ModalEntry | null>(null);
  const opening = useRef({ open: false, order: 0 });
  if (open && !opening.current.open) opening.current.order = ++nextOrder;
  opening.current.open = open;
  const latest = useRef({ onClose, busy, initialFocusRef });
  latest.current = { onClose, busy, initialFocusRef };
  const [isTopmost, setIsTopmost] = useState(false);
  const requestClose = useCallback(() => {
    if (entryRef.current === stack[stack.length - 1] && !latest.current.busy) latest.current.onClose();
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const overlay = overlayRef.current ?? dialog;
    const entry: ModalEntry = {
      dialog,
      overlay,
      previous: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      initialFocus: () => latest.current.initialFocusRef?.current ?? null,
      close: requestClose,
      changed: setIsTopmost,
      zIndex: overlay.style.zIndex,
      order: opening.current.order,
    };
    entryRef.current = entry;
    const unregister = register(entry);
    return () => {
      unregister();
      entryRef.current = null;
    };
  }, [open, requestClose]);

  return { dialogRef, overlayRef, isTopmost: open && isTopmost, requestClose };
}
