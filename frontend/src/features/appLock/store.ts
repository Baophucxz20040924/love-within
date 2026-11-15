import { apiRequest } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { spaceStore, type Space } from '../../lib/spaceStore';
import { setAppMask } from './mask';

export interface LockSettings { couple: boolean; friends: boolean; revision: number }
type Phase = 'loading' | 'ready' | 'locked' | 'error' | 'opening';
declare global { interface Window { __lwAppLock: { protected: boolean; epoch: number } } }
const boot = window.__lwAppLock;
let epoch = boot.epoch;
let generation = tokenStore.generation();
let settings: LockSettings | null = null;
let phase: Phase = tokenStore.get() ? 'loading' : 'ready';
let discard = Boolean(tokenStore.get());
let version = 0;
let flight = 0;
let passwordGrant: { generation: string; epoch: number; space: Space } | null = null;
let title = 'Love Within';
let friendsTheme = false;
const listeners = new Set<() => void>();
export function subscribeAppLock(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function appLockVersion(): number { return version; }
export function appLockEpoch(): number { return epoch; }
export function appLockState() { return { phase, discard, settings, version }; }
export function isAppLocked(): boolean { return phase !== 'ready'; }
export function isAppLockCurrent(value: number): boolean { return epoch === value && !isAppLocked() && document.visibilityState === 'visible'; }
export function isAuthAttemptCurrent(value: number): boolean { return epoch === value && document.visibilityState === 'visible'; }
function presentation() {
  document.title = isAppLocked() ? 'Love Within' : title;
  if (friendsTheme && !isAppLocked()) document.documentElement.dataset.theme = 'friends';
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = friendsTheme && !isAppLocked() ? '#f3f6fb' : '#faf7f8';
}
export function setAppTitle(value: string): void { title = value; presentation(); }
export function setAppTheme(value: boolean): void { friendsTheme = value; presentation(); }
function publish() {
  boot.protected = Boolean(tokenStore.get());
  setAppMask('lock', isAppLocked());
  presentation();
  version += 1;
  for (const fn of listeners) fn();
}
export function appLockSurfaceReady(): void { document.documentElement.removeAttribute('data-app-shield'); }
export function resetAppLock(): void {
  epoch += 1; flight += 1; generation = tokenStore.generation();
  passwordGrant = null; settings = null; title = 'Love Within'; friendsTheme = false;
  discard = Boolean(tokenStore.get()); phase = tokenStore.get() ? 'loading' : 'ready'; publish();
}
export function bindPasswordLogin(target: Space, expected: number): void {
  generation = tokenStore.generation(); settings = null; flight += 1;
  passwordGrant = isAuthAttemptCurrent(expected) ? { generation, epoch, space: target } : null;
  discard = true; phase = 'loading'; publish();
}
export async function refreshLockSettings(preserveEntry = true): Promise<void> {
  const id = ++flight, currentGeneration = tokenStore.generation(), expected = epoch;
  if (!tokenStore.get()) { resetAppLock(); return; }
  const old = settings;
  try {
    const next = await apiRequest<LockSettings>('/privacy-lock');
    if (id !== flight || expected !== epoch || !tokenStore.isCurrent(currentGeneration)) return;
    if (!next || typeof next.couple !== 'boolean' || typeof next.friends !== 'boolean' || !Number.isSafeInteger(next.revision) || next.revision < 0) throw new Error('Invalid lock configuration');
    generation = currentGeneration; settings = next;
    const target = spaceStore.get();
    const authenticated = passwordGrant?.generation === generation && passwordGrant.epoch === epoch && passwordGrant.space === target;
    const existingEntry = preserveEntry && phase === 'ready' && old?.revision === next.revision;
    passwordGrant = null;
    if (!next[target] || authenticated || existingEntry) { phase = 'ready'; discard = false; }
    else { phase = 'locked'; discard = true; }
    publish();
  } catch {
    if (id === flight && expected === epoch && tokenStore.isCurrent(currentGeneration)) { phase = 'error'; publish(); }
  }
}
export async function unlockApp(pin: string): Promise<Space | null> {
  if (phase !== 'locked' || document.visibilityState !== 'visible') return null;
  const expected = epoch, currentGeneration = tokenStore.generation(), revision = settings?.revision;
  const result = await apiRequest<{ space: Space; revision: number }>('/privacy-lock/unlock', { method: 'POST', body: { pin } });
  if (expected !== epoch || !tokenStore.isCurrent(currentGeneration) || document.visibilityState !== 'visible' || phase !== 'locked') return null;
  if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
      (result.space !== 'couple' && result.space !== 'friends')) throw new Error('Không thể xác minh mã. Vui lòng thử lại.');
  if (settings?.revision !== revision) return null;
  if (result.revision !== revision) { await refreshLockSettings(false); return null; }
  if (!settings?.[result.space]) return null;
  phase = 'opening'; discard = true; title = 'Love Within'; publish();
  return result.space;
}
export function finishAppUnlock(): void {
  if (phase !== 'opening' || document.visibilityState !== 'visible') return;
  phase = 'ready'; discard = false; publish();
}
export function lockForNavigation(): void {
  if (!tokenStore.get()) return;
  epoch += 1; passwordGrant = null; phase = 'loading'; discard = true; publish();
  void refreshLockSettings(false);
}
export function applyOwnLockSettings(next: LockSettings): void {
  if (phase !== 'ready') return;
  settings = next;
  notifyLockSettingsChanged();
  publish();
}
export function notifyLockSettingsChanged(): void {
  // Only a nonce, never PINs or configuration, crosses tabs.
  localStorage.setItem('lw.lockSettingsChanged', crypto.randomUUID());
}
function conceal() {
  epoch = Math.max(epoch + 1, boot.epoch); flight += 1; passwordGrant = null;
  if (tokenStore.get()) {
    const enabled = settings?.[spaceStore.get()];
    discard = discard || enabled !== false;
    phase = enabled ? 'locked' : 'loading';
  }
  publish();
}
window.addEventListener('lw:app-lock', conceal);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tokenStore.get()) void refreshLockSettings(false);
});
window.addEventListener('pageshow', event => { if (event.persisted && tokenStore.get()) void refreshLockSettings(false); });
window.addEventListener('storage', event => {
  if (event.key === null || (event.key && tokenStore.isSessionKey(event.key) && generation !== tokenStore.generation())) { resetAppLock(); void refreshLockSettings(false); }
  else if (event.key === 'lw.lockSettingsChanged' || (event.key && spaceStore.isSpaceKey(event.key))) lockForNavigation();
});
publish();
