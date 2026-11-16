import { ApiRequestError, assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { detectDevice, isStandalone } from '../../lib/installPrompt';
import { pushApi } from './api';

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
async function browserSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== 'supported') return null;
  return withTimeout((await registration()).pushManager.getSubscription(), SW_TIMEOUT_MS);
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
async function ensureBrowserSubscription(publicKey: string, guard: () => void): Promise<PushSubscription> {
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
  if (sub) return sub;
  // A timed-out browser request can still complete. Drop that orphan only if no newer opt-in owns it.
  const pending = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  let timedOut = false;
  void pending.then(late => {
    if (timedOut) void serialize(async () => {
      if (!readRecord()) await withTimeout(late.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
    });
  }, () => undefined);
  try {
    return await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS);
  } catch (error) {
    timedOut = true;
    throw error;
  }
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

export async function enableOnThisDevice(userId: string): Promise<void> {
  const generation = tokenStore.generation();
  const expected = ++intent;
  if (pushAvailability() !== 'supported') throw new PushSetupError('unavailable', 'Máy này chưa nhận được thông báo.');
  // Invoke synchronously from the tap, before joining the mutation queue (required by Safari).
  const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
  // An unanswered OS prompt must not hold the mutation queue or cross-tab device lock.
  const granted = await permission;
  check(generation, expected);
  return serialize(async () => {
    check(generation, expected);
    if (granted === 'denied') {
      notifyDeviceChanged();
      throw new PushSetupError('denied', 'Thông báo đang bị chặn. Xem cách bật lại ở bên dưới.');
    }
    if (granted !== 'granted') throw new PushSetupError('dismissed', 'Bạn chưa cho phép thông báo.');
    const config = await pushApi.config();
    check(generation, expected);
    if (!config.enabled || !config.publicKey) throw new PushSetupError('unavailable', 'Máy chủ chưa bật thông báo.');
    const sub = await ensureBrowserSubscription(config.publicKey, () => check(generation, expected));
    check(generation, expected);
    try {
      await pushApi.subscribe(bodyOf(sub));
    } catch (error) {
      if (tokenStore.isCurrent(generation) && intent === expected && error instanceof ApiRequestError && error.code === 'BAD_ENDPOINT') {
        await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
      }
      throw error;
    }
    check(generation, expected);
    writeRecord({ userId, endpoint: sub.endpoint, syncedAt: Date.now(), version: RECORD_VERSION });
    notifyDeviceChanged();
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

export function disableOnThisDevice(): Promise<void> {
  const generation = tokenStore.generation();
  const accessToken = tokenStore.get()?.accessToken ?? null;
  const expected = ++intent;
  const record = readRecord();
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
export function syncThisDevice(userId: string): Promise<void> {
  const generation = tokenStore.generation();
  const expected = intent;
  return serialize(async () => {
    check(generation, expected);
    if (pushAvailability() !== 'supported') return;
    // A temporary SW failure must not erase consent or an otherwise healthy subscription.
    let sub: PushSubscription | null;
    try { sub = await browserSubscription(); } catch { return; }
    check(generation, expected);
    const record = readRecord();
    if (!sub || !isMine(record, userId) || Notification.permission !== 'granted') {
      if (isMine(record, userId)) await pushApi.unsubscribe(record.endpoint).catch(() => undefined);
      check(generation, expected);
      if (sub) await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
      check(generation, expected);
      if (record) { writeRecord(null); notifyDeviceChanged(); }
      return;
    }
    const config = await pushApi.config().catch(() => null);
    check(generation, expected);
    if (!config?.enabled || !config.publicKey) return;
    const current = sameKey(sub.options.applicationServerKey, keyBytes(config.publicKey))
      ? sub : await ensureBrowserSubscription(config.publicKey, () => check(generation, expected));
    check(generation, expected);
    if (record.version === RECORD_VERSION && current.endpoint === record.endpoint && Date.now() - record.syncedAt < RESYNC_MS) return;
    if (current.endpoint !== record.endpoint) {
      await pushApi.unsubscribe(record.endpoint).catch(() => undefined);
      check(generation, expected);
    }
    await pushApi.subscribe(bodyOf(current));
    check(generation, expected);
    writeRecord({ userId, endpoint: current.endpoint, syncedAt: Date.now(), version: RECORD_VERSION });
    notifyDeviceChanged();
  });
}
