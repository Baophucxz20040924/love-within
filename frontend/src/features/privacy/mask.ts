import { setModalPrivacyPause } from '../../hooks/useModal';

type Reason = 'hidden' | 'verification';
const reasons = new Set<Reason>();
const listeners = new Set<() => void>();
const masked = new Map<HTMLElement, { display: string; priority: string; inert: boolean; aria: string | null }>();
let observer: MutationObserver | undefined;
let verificationHost: HTMLElement | null = null;

export function subscribeMask(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isMasked(): boolean { return reasons.size > 0; }
export function setVerificationHost(host: HTMLElement): void { verificationHost = host; }
function restore(node: HTMLElement) {
  const before = masked.get(node);
  if (!before) return;
  if (before.display) node.style.setProperty('display', before.display, before.priority);
  else node.style.removeProperty('display');
  node.inert = before.inert;
  if (before.aria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', before.aria);
  masked.delete(node);
}
function sync() {
  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement) || node.tagName === 'SCRIPT') continue;
    const allowed = reasons.has('hidden') ? node.id === 'privacy-entry' || node.id === 'privacy-bootstrap' : node === verificationHost;
    if (!reasons.size || allowed) { restore(node); continue; }
    if (!masked.has(node)) masked.set(node, { display: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display'), inert: node.inert, aria: node.getAttribute('aria-hidden') });
    node.style.setProperty('display', 'none', 'important');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
}
export function setMask(reason: Reason, enabled: boolean): void {
  if (enabled) reasons.add(reason); else reasons.delete(reason);
  if (reasons.size) document.documentElement.setAttribute('data-privacy-mask', reasons.has('hidden') ? 'hidden' : 'verification');
  else document.documentElement.removeAttribute('data-privacy-mask');
  if (reasons.size) {
    setModalPrivacyPause(true);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media => media.pause());
    sync();
    if (!observer) { observer = new MutationObserver(sync); observer.observe(document.body, { childList: true }); }
  } else {
    observer?.disconnect(); observer = undefined;
    for (const node of masked.keys()) restore(node);
    setModalPrivacyPause(false);
  }
  for (const listener of listeners) listener();
}
// A retained player must not restart behind either cover, including native control actions.
document.addEventListener('play', event => {
  if (isMasked() && event.target instanceof HTMLMediaElement) event.target.pause();
}, true);
