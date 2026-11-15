import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { setModalPrivacyPause } from '../../hooks/useModal';

type Status = 'clear' | 'checking' | 'failed';
/** Media must stop while private content is masked, even though its React tree stays mounted. */
export function subscribeVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getVerificationStatus(): Status { return status; }
let status: Status = 'clear';
let retry: (() => void) | undefined;
let maskObserver: MutationObserver | undefined;
const masked = new Map<HTMLElement, { display: string; priority: string; inert: boolean; aria: string | null }>();
let statusHost: HTMLElement | null = null;
function maskBodyChildren() {
  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement) || node === statusHost || masked.has(node) || node.tagName === 'SCRIPT') continue;
    masked.set(node, { display: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display'), inert: node.inert, aria: node.getAttribute('aria-hidden') });
    node.style.setProperty('display', 'none', 'important');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
}
function setPrivacyMask(mask: boolean) {
  if (mask) {
    setModalPrivacyPause(true);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    maskBodyChildren();
    if (!maskObserver) { maskObserver = new MutationObserver(maskBodyChildren); maskObserver.observe(document.body, { childList: true }); }
  } else {
    maskObserver?.disconnect(); maskObserver = undefined;
    for (const [node, before] of masked) {
      if (!node.isConnected) continue;
      if (before.display) node.style.setProperty('display', before.display, before.priority); else node.style.removeProperty('display');
      node.inert = before.inert;
      if (before.aria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', before.aria);
    }
    masked.clear();
    setModalPrivacyPause(false);
  }
}
const listeners = new Set<() => void>();
function update(next: Status) {
  status = next;
  for (const listener of listeners) listener();
}
export function setVerification(next: Status, onRetry?: () => void): void {
  retry = onRetry;
  if (next !== 'clear' && !statusHost) {
    statusHost = document.createElement('div');
    statusHost.setAttribute('data-realtime-verification', '');
    document.body.appendChild(statusHost);
  }
  const previous = status;
  if (previous === 'clear' && next !== 'clear') setPrivacyMask(true);
  if (previous !== 'clear' && next === 'clear') setPrivacyMask(false);
  update(next);
  // Keep a stable portal host; removing it before React commits would lose the status tree.
}

/** Keep the routed tree mounted, but inaccessible visually, to assistive technology and to input. */
export function RealtimeBoundary({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => status,
    () => 'clear' as Status,
  );
  return <>
    {children}
    {state !== 'clear' && statusHost && createPortal(<main className="app-content" role="status" aria-live="polite">
      <p>{state === 'checking' ? 'Đang kiểm tra lại quyền truy cập…' : 'Chưa kiểm tra được quyền truy cập. Nội dung được tạm ẩn để bảo vệ dữ liệu.'}</p>
      {state === 'failed' && <button type="button" className="btn btn-primary" onClick={() => retry?.()}>Thử lại</button>}
    </main>, statusHost)}
  </>;
}
