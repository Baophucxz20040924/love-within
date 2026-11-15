import { tokenStore } from '../../lib/tokenStore';
import { spaceStore } from '../../lib/spaceStore';
import { setMask } from './mask';

declare global {
  interface Window { __lwPrivacy: { epoch: number; active: boolean; locked: boolean } }
}
const boot = window.__lwPrivacy;
const listeners = new Set<() => void>();
let epoch = boot.epoch;
let generation = tokenStore.generation();
let granted = false;
let active = spaceStore.get() === 'friends' || isHiddenPath(location.pathname);
let locked = active;
let version = 0;
let pending: { path: string; generation: string } | undefined;
let title = 'Love Within';
let friendsTheme = false;

export function isHiddenPath(path: string): boolean {
  return /^\/(friends(?:\/|$)|j(?:\/|$))/.test(path);
}
export function subscribePrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function privacyVersion(): number { return version; }
export function isPrivacyLocked(): boolean { return locked; }
export function privacyEpoch(): number { return epoch; }
export function canEnterHidden(): boolean {
  return granted && !locked && tokenStore.isCurrent(generation) && document.visibilityState === 'visible';
}
export function isPrivacyCurrent(expected: number): boolean {
  return epoch === expected && !locked && document.visibilityState === 'visible';
}
function presentation() {
  document.title = locked ? 'Love Within' : title;
  if (friendsTheme && !locked) document.documentElement.dataset.theme = 'friends';
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = friendsTheme && !locked ? '#f3f6fb' : '#faf7f8';
}
export function setPrivacyTitle(next: string): void { title = next; presentation(); }
export function setPrivacyTheme(next: boolean): void { friendsTheme = next; presentation(); }
function publish() {
  boot.active = active;
  boot.locked = locked;
  setMask('hidden', locked);
  presentation();
  version += 1;
  for (const listener of listeners) listener();
}
export function lockPrivacy(): void {
  epoch = Math.max(epoch + 1, boot.epoch);
  granted = false;
  if (active) locked = true;
  publish();
}
/** Only called by the heart/boat interaction in this document. */
export function enterHidden(): boolean {
  if (document.visibilityState !== 'visible') return false;
  active = true;
  granted = true;
  generation = tokenStore.generation();
  locked = false;
  publish();
  return true;
}
/** Bind a legitimate login to its new token generation, never a stale gesture. */
export function bindPrivacySession(expectedEpoch: number, target: 'couple' | 'friends'): void {
  generation = tokenStore.generation();
  active = target === 'friends';
  if (active) {
    granted = granted && epoch === expectedEpoch && document.visibilityState === 'visible';
    locked = !granted;
  } else { granted = false; locked = false; }
  publish();
}
export function reconcilePrivacySession(): void {
  const changed = generation !== tokenStore.generation();
  generation = tokenStore.generation();
  if (changed) { epoch += 1; granted = false; pending = undefined; }
  active = spaceStore.get() === 'friends' || isHiddenPath(location.pathname);
  locked = active && !granted;
  publish();
}
export function guardHiddenPath(path: string): void {
  if (!isHiddenPath(path) || canEnterHidden()) return;
  active = true; locked = true; publish();
}
export function deferPrivateNavigation(path: string): void {
  pending = { path, generation: tokenStore.generation() };
}
export function takePrivateNavigation(): string | undefined {
  const next = pending; pending = undefined;
  return next && tokenStore.isCurrent(next.generation) && canEnterHidden() ? next.path : undefined;
}
/** Called after the cover has committed or a safe public screen is ready. */
export function privacySurfaceReady(): void {
  document.documentElement.removeAttribute('data-privacy-shield');
}
window.addEventListener('lw:privacy-lock', lockPrivacy);
window.addEventListener('storage', event => {
  if (event.key === null || tokenStore.isSessionKey(event.key) || spaceStore.isSpaceKey(event.key)) reconcilePrivacySession();
});
// The bootstrap installs this attribute before the application module is evaluated.
publish();
