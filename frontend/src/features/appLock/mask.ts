import { setModalPrivacyPause } from '../../hooks/useModal';

type Reason = 'lock' | 'verification';
const reasons = new Set<Reason>();
const masked = new Map<HTMLElement, { display: string; priority: string; inert: boolean; aria: string | null }>();
let observer: MutationObserver | undefined;
let verificationHost: HTMLElement | null = null;
export function setVerificationHost(host: HTMLElement): void { verificationHost = host; }
export function isAppMasked(): boolean { return reasons.size > 0; }
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
    const allowed = reasons.has('lock') ? node.id === 'app-lock-entry' || node.id === 'app-lock-bootstrap' : node === verificationHost;
    if (!reasons.size || allowed) { restore(node); continue; }
    if (!masked.has(node)) masked.set(node, { display: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display'), inert: node.inert, aria: node.getAttribute('aria-hidden') });
    node.style.setProperty('display', 'none', 'important');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
}
export function setAppMask(reason: Reason, enabled: boolean): void {
  if (enabled) reasons.add(reason); else reasons.delete(reason);
  if (reasons.size) document.documentElement.setAttribute('data-app-mask', reasons.has('lock') ? 'lock' : 'verification');
  else document.documentElement.removeAttribute('data-app-mask');
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
}
document.addEventListener('play', event => {
  if (isAppMasked() && event.target instanceof HTMLMediaElement) event.target.pause();
}, true);
