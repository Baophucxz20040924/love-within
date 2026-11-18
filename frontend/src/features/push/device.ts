import { ApiRequestError, assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { detectDevice, isStandalone } from '../../lib/installPrompt';
import { pushApi } from './api';
import { setPushExplicitlyOff } from './onboardingPolicy';

/** Permission is requested only from a tap. One device opt-in covers both spaces of the same account. */
export type DeviceState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

const RECORD_KEY = 'lw.push.device';
const RESYNC_MS = 12 * 3_600_000;
const SW_TIMEOUT_MS = 8_000;
const SUBSCRIBE_TIMEOUT_MS = 45_000;
const LOGOUT_STEP_MS = 3_000;
const RECORD_VERSION = 2;

interface DeviceRecord {
  userId: string;
  endpoint: string;
  syncedAt: number;
  version?: number;
}

function readRecord(): DeviceRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<DeviceRecord> & { space?: unknown };
    if (typeof r.userId === 'string' && typeof r.endpoint === 'string' &&
      (r.version === RECORD_VERSION || r.space === 'couple' || r.space === 'friends')) {
      return { userId: r.userId, endpoint: r.endpoint, syncedAt: Number(r.syncedAt) || 0, version: r.version };
    }
  } catch {
    // Unreadable storage is not consent to enable notifications.
  }
  return null;
}

function writeRecord(r: DeviceRecord | null): void {
  try {
    if (r) localStorage.setItem(RECORD_KEY, JSON.stringify(r));
    else localStorage.removeItem(RECORD_KEY);
  } catch {
    // Storage disabled: re-check ownership on the next start.
  }
}

const listeners = new Set<() => void>();
let version = 0;
export function notifyDeviceChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}
export function subscribeDevice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function deviceVersion(): number { return version; }

// Explicit user intents invalidate older work immediately. Browser/server mutations run in order so an old
// DELETE/unsubscribe cannot overtake a newer enable, including a new login reusing the same endpoint.
let intent = 0;
let mutations: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const exclusive = () => navigator.locks
    ? navigator.locks.request(RECORD_KEY, () => work())
    : work();
  const next = mutations.then(exclusive, exclusive);
  mutations = next.catch(() => undefined);
  return next;
}
function check(generation: string, expected: number): void {
  assertCurrentSession(generation);
  if (intent !== expected) throw new ApiRequestError(409, 'PUSH_CHANGED', 'Cài đặt thông báo đã thay đổi.');
}

export function pushAvailability(): 'supported' | 'ios-install' | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (detectDevice().platform === 'ios' && !isStandalone()) return 'ios-install';
  const apis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!apis || !import.meta.env.PROD) return 'unsupported';
  return 'supported';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });
}
function registration(): Promise<ServiceWorkerRegistration> {
  return withTimeout(navigator.serviceWorker.ready, SW_TIMEOUT_MS);
}
async function browserSubscription(guard: () => void = () => undefined): Promise<PushSubscription | null> {
  guard();
  if (pushAvailability() !== 'supported') return null;
  const reg = await registration();
  guard();
  const sub = await withTimeout(reg.pushManager.getSubscription(), SW_TIMEOUT_MS);
  guard();
  return sub;
}
export async function currentEndpoint(): Promise<string | null> {
  return (await browserSubscription().catch(() => null))?.endpoint ?? null;
}
function keyBytes(base64url: string): Uint8Array {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, index) => value === key[index]);
}
function bodyOf(sub: PushSubscription) {
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } };
}
async function discardOrphan(sub: PushSubscription): Promise<void> {
  // Called under the mutation lock. A later opt-in may have adopted a timed-out subscription.
  if (readRecord()?.endpoint !== sub.endpoint) {
    await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
  }
}
async function ensureBrowserSubscription(publicKey: string, guard: () => void): Promise<{ sub: PushSubscription; created: boolean }> {
  guard();
  const reg = await registration();
  guard();
  const key = keyBytes(publicKey);
  let sub = await withTimeout(reg.pushManager.getSubscription(), SW_TIMEOUT_MS);
  guard();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS);
    guard();
    sub = null;
  }
  if (sub) return { sub, created: false };
  // A timed-out browser request can still complete. Serialize cleanup behind any newer owner.
  const pending = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  let timedOut = false;
  void pending.then(late => {
    if (timedOut) void serialize(() => discardOrphan(late)).catch(() => undefined);
  }, () => undefined);
  try {
    sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS);
  } catch (error) {
    timedOut = true;
    throw error;
  }
  try { guard(); } catch (error) {
    await discardOrphan(sub);
    throw error;
  }
  return { sub, created: true };
}
function isMine(record: DeviceRecord | null, userId: string): record is DeviceRecord {
  return record !== null && record.userId === userId;
}
export async function readDeviceState(userId: string): Promise<DeviceState> {
  const availability = pushAvailability();
  if (availability !== 'supported') return availability;
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const sub = await browserSubscription().catch(() => null);
  const record = readRecord();
  return sub && isMine(record, userId) && record.endpoint === sub.endpoint ? 'on' : 'off';
}

export type PushSetupErrorCode = 'unavailable' | 'denied' | 'dismissed' | 'failed';
export class PushSetupError extends Error {
  readonly code: PushSetupErrorCode;
  constructor(code: PushSetupErrorCode, message: string) { super(message); this.code = code; }
}

export async function enableOnThisDevice(userId: string, guard: () => void = () => undefined): Promise<void> {
  // Do not even invalidate another intent or open the OS prompt from a stale/locked UI.
  guard();
  const generation = tokenStore.generation();
  const accessToken = tokenStore.get()?.accessToken ?? null;
  const expected = ++intent;
  const current = () => { check(generation, expected); guard(); };
  current();
  if (pushAvailability() !== 'supported') throw new PushSetupError('unavailable', 'Máy này chưa nhận được thông báo.');
  // Invoke synchronously from the tap, before joining the mutation queue (required by Safari).
  const permission: Promise<NotificationPermission> = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
  // An unanswered OS prompt must not hold the mutation queue or cross-tab device lock.
  let granted: NotificationPermission;
  try { granted = await permission; } catch (error) { current(); throw error; }
  current();
  return serialize(async () => {
    current();
    if (granted === 'denied') {
      notifyDeviceChanged();
      throw new PushSetupError('denied', 'Thông báo đang bị chặn. Xem cách bật lại ở bên dưới.');
    }
    if (granted !== 'granted') throw new PushSetupError('dismissed', 'Bạn chưa cho phép thông báo.');
    let subscription: { sub: PushSubscription; created: boolean } | undefined;
    let posted = false;
    try {
      const config = await pushApi.config();
      current();
      if (!config.enabled || !config.publicKey) throw new PushSetupError('unavailable', 'Máy chủ chưa bật thông báo.');
      subscription = await ensureBrowserSubscription(config.publicKey, current);
      current();
      posted = true;
      await pushApi.subscribe(bodyOf(subscription.sub));
      current();
      writeRecord({ userId, endpoint: subscription.sub.endpoint, syncedAt: Date.now(), version: RECORD_VERSION });
      notifyDeviceChanged();
    } catch (error) {
      try { current(); } catch (stale) {
        // Access can close while subscribe/POST is pending. Cleanup uses only captured credentials,
        // under the same lock, and must not tear down a subscription already owned by another opt-in.
        if (subscription && readRecord()?.endpoint !== subscription.sub.endpoint) {
          if (posted) await deleteEndpoint(subscription.sub.endpoint, accessToken);
          if (subscription.created) await discardOrphan(subscription.sub);
        }
        throw stale;
      }
      if (subscription && error instanceof ApiRequestError && error.code === 'BAD_ENDPOINT') {
        await withTimeout(subscription.sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
        current();
        if (readRecord()?.endpoint === subscription.sub.endpoint) { writeRecord(null); notifyDeviceChanged(); }
      }
      throw error;
    }
  });
}

/** Captured credentials ensure cleanup never borrows a newer account's login. */
async function deleteEndpoint(endpoint: string | undefined, accessToken: string | null): Promise<void> {
  if (!endpoint || !accessToken) return;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), LOGOUT_STEP_MS);
  try {
    await fetch('/api/push/subscriptions', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ endpoint }), signal: controller.signal, cache: 'no-store',
    }).catch(() => undefined);
  } finally { window.clearTimeout(timer); }
}

export function disableOnThisDevice(userId?: string): Promise<void> {
  const generation = tokenStore.generation();
  const accessToken = tokenStore.get()?.accessToken ?? null;
  const expected = ++intent;
  const record = readRecord();
  const owner = userId ?? record?.userId;
  if (owner) setPushExplicitlyOff(owner);
  writeRecord(null);
  notifyDeviceChanged();
  return serialize(async () => {
    check(generation, expected);
    const sub = await browserSubscription().catch(() => null);
    check(generation, expected);
    await deleteEndpoint(record?.endpoint, accessToken);
    if (sub?.endpoint !== record?.endpoint) await deleteEndpoint(sub?.endpoint, accessToken);
    check(generation, expected);
    if (sub) await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
    check(generation, expected);
    writeRecord(null);
    notifyDeviceChanged();
  });
}

export function forgetThisDevice(accessToken: string | null = tokenStore.get()?.accessToken ?? null): Promise<void> {
  const record = readRecord();
  ++intent;
  writeRecord(null);
  notifyDeviceChanged();
  return serialize(async () => {
    // A newer cross-tab opt-in may have completed before we acquired the shared device lock.
    if (readRecord()) return;
    const sub = await withTimeout(browserSubscription(), LOGOUT_STEP_MS).catch(() => null);
    if (readRecord()) return;
    await deleteEndpoint(record?.endpoint, accessToken);
    if (sub?.endpoint !== record?.endpoint) await deleteEndpoint(sub?.endpoint, accessToken);
    // Serialized new opt-ins cannot own this subscription yet, including one rotated by stale sync.
    if (sub && !tokenStore.get() && !readRecord()) {
      await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
    }
  }).catch(() => undefined);
}

/** Refresh only an existing opt-in. A legacy same-user record upgrades once, regardless of its old space. */
export function syncThisDevice(userId: string, guard: () => void = () => undefined): Promise<void> {
  const generation = tokenStore.generation();
  const expected = intent;
  const current = () => { check(generation, expected); guard(); };
  return serialize(async () => {
    current();
    if (pushAvailability() !== 'supported') return;
    // A temporary SW failure must not erase consent or an otherwise healthy subscription.
    let sub: PushSubscription | null;
    try { sub = await browserSubscription(current); } catch { current(); return; }
    current();
    const record = readRecord();
    if (!sub || !isMine(record, userId) || sub.endpoint !== record.endpoint || Notification.permission !== 'granted') {
      if (isMine(record, userId)) await pushApi.unsubscribe(record.endpoint).catch(() => undefined);
      current();
      if (sub) await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
      current();
      if (record) { writeRecord(null); notifyDeviceChanged(); }
      return;
    }
    const config = await pushApi.config().catch(() => null);
    current();
    if (!config?.enabled || !config.publicKey) return;
    if (!sameKey(sub.options.applicationServerKey, keyBytes(config.publicKey))) {
      // Rotation requires a new browser subscription, which belongs exclusively to an explicit tap.
      await pushApi.unsubscribe(record.endpoint).catch(() => undefined);
      current();
      await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
      current();
      writeRecord(null);
      notifyDeviceChanged();
      return;
    }
    if (record.version === RECORD_VERSION && Date.now() - record.syncedAt < RESYNC_MS) return;
    try { await pushApi.subscribe(bodyOf(sub)); } catch (error) {
      current();
      if (error instanceof ApiRequestError && error.code === 'BAD_ENDPOINT') {
        await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
        current();
        writeRecord(null);
        notifyDeviceChanged();
      }
      throw error;
    }
    current();
    writeRecord({ userId, endpoint: sub.endpoint, syncedAt: Date.now(), version: RECORD_VERSION });
    notifyDeviceChanged();
  });
}
