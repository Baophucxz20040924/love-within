import { ApiRequestError, assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { detectDevice, isStandalone } from '../../lib/installPrompt';
import type { PushSpace } from '../../lib/types';
import { pushApi } from './api';

/**
 * Web Push on this browser (plan/OPERATIONS.md, N4): permission, the browser's PushSubscription and which user and
 * space it was turned on for. Permission is only ever asked from a tap (enableOnThisDevice), never at app start.
 *
 * A device belongs to one user and one space at a time. That owner is kept in localStorage next to the endpoint, so
 * on app start the subscription is re-sent only when it belongs to the signed-in user and the session's space; a
 * subscription left by someone else (or by the other space) is dropped, so their pushes never show in this session.
 */

/** What this browser can do with notifications now. */
export type DeviceState =
  /** No service worker or PushManager (older browser, desktop without support, dev build without service worker). */
  | 'unsupported'
  /** iPhone / iPad outside the Home Screen app: push needs the installed app (iOS 16.4+). */
  | 'ios-install'
  /** The user blocked notifications for this site. */
  | 'denied'
  /** Can be turned on (permission not asked yet, or granted but off for this user / space). */
  | 'off'
  /** This device receives this user's pushes for this space. */
  | 'on';

const RECORD_KEY = 'lw.push.device';
/** The subscription is re-sent on app start at most this often (refreshes the server row, stays far below 30 saves / h). */
const RESYNC_MS = 12 * 3_600_000;
const SW_TIMEOUT_MS = 8_000;
/**
 * The browser registers with its push service (Google, Apple, Mozilla…) here; a stuck network must not leave the switch
 * spinning. A fresh Chromium profile took 30–35 s against Google's service in tests, so the bound is generous.
 */
const SUBSCRIBE_TIMEOUT_MS = 45_000;
/** Background logout cleanup is bounded per step; credentials are cleared synchronously. */
const LOGOUT_STEP_MS = 3_000;

interface DeviceRecord {
  userId: string;
  space: PushSpace;
  endpoint: string;
  syncedAt: number;
}

function readRecord(): DeviceRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<DeviceRecord>;
    if (typeof r.userId === 'string' && (r.space === 'couple' || r.space === 'friends') && typeof r.endpoint === 'string') {
      return { userId: r.userId, space: r.space, endpoint: r.endpoint, syncedAt: Number(r.syncedAt) || 0 };
    }
  } catch {
    // unreadable: treated as no owner
  }
  return null;
}

function writeRecord(r: DeviceRecord | null): void {
  try {
    if (r) localStorage.setItem(RECORD_KEY, JSON.stringify(r));
    else localStorage.removeItem(RECORD_KEY);
  } catch {
    // storage disabled: the device is re-checked on the next start
  }
}

// Change signal: the settings page and the suggestion card re-read the state after a switch here or elsewhere.
const listeners = new Set<() => void>();
let version = 0;

export function notifyDeviceChanged(): void {
  version += 1;
  for (const l of listeners) l();
}

export function subscribeDevice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function deviceVersion(): number {
  return version;
}

/** Whether push can work here at all (permission and subscription not checked). */
export function pushAvailability(): 'supported' | 'ios-install' | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (detectDevice().platform === 'ios' && !isStandalone()) return 'ios-install';
  const apis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // The service worker is only registered in production builds (main.tsx).
  if (!apis || !import.meta.env.PROD) return 'unsupported';
  return 'supported';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

function registration(): Promise<ServiceWorkerRegistration> {
  return withTimeout(navigator.serviceWorker.ready, SW_TIMEOUT_MS);
}

async function browserSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== 'supported') return null;
  try {
    return await (await registration()).pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** The endpoint of this device, for "Gửi thử". */
export async function currentEndpoint(): Promise<string | null> {
  return (await browserSubscription())?.endpoint ?? null;
}

function keyBytes(base64url: string): Uint8Array {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current) return true; // the browser does not say: keep the subscription
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((v, i) => v === key[i]);
}

function bodyOf(sub: PushSubscription, space: PushSpace) {
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, space };
}

/** The browser's subscription for the server's key (a new one when the server key changed). Needs permission. */
async function ensureBrowserSubscription(publicKey: string, generation: string): Promise<PushSubscription> {
  const reg = await registration();
  assertCurrentSession(generation);
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  assertCurrentSession(generation);
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    assertCurrentSession(generation);
    sub = null;
  }
  return sub ?? withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), SUBSCRIBE_TIMEOUT_MS);
}

function isMine(r: DeviceRecord | null, userId: string, space: PushSpace): r is DeviceRecord {
  return r !== null && r.userId === userId && r.space === space;
}

export async function readDeviceState(userId: string, space: PushSpace): Promise<DeviceState> {
  const availability = pushAvailability();
  if (availability !== 'supported') return availability;
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const [sub, rec] = [await browserSubscription(), readRecord()];
  return sub && isMine(rec, userId, space) && rec.endpoint === sub.endpoint ? 'on' : 'off';
}

export type PushSetupErrorCode = 'unavailable' | 'denied' | 'dismissed' | 'failed';

export class PushSetupError extends Error {
  readonly code: PushSetupErrorCode;
  constructor(code: PushSetupErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Turn notifications on for this device, user and space. Call it from a tap: it may show the permission prompt. */
export async function enableOnThisDevice(userId: string, space: PushSpace): Promise<void> {
  const generation = tokenStore.generation();
  if (pushAvailability() !== 'supported') throw new PushSetupError('unavailable', 'Máy này chưa nhận được thông báo.');
  // First await of the tap handler: Safari only shows the prompt during a user gesture.
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  assertCurrentSession(generation);
  if (permission === 'denied') {
    notifyDeviceChanged();
    throw new PushSetupError('denied', 'Thông báo đang bị chặn. Xem cách bật lại ở bên dưới.');
  }
  if (permission !== 'granted') throw new PushSetupError('dismissed', 'Bạn chưa cho phép thông báo.');
  const config = await pushApi.config();
  assertCurrentSession(generation);
  if (!config.enabled || !config.publicKey) throw new PushSetupError('unavailable', 'Máy chủ chưa bật thông báo.');
  let sub: PushSubscription;
  try {
    sub = await ensureBrowserSubscription(config.publicKey, generation);
  } catch {
    throw new PushSetupError('failed', 'Không bật được thông báo trên máy này. Thử lại sau nhé.');
  }
  assertCurrentSession(generation);
  try {
    await pushApi.subscribe(bodyOf(sub, space));
  } catch (err) {
    // A push service the server does not accept: do not leave a subscription nobody uses.
    if (tokenStore.isCurrent(generation) && err instanceof ApiRequestError && err.code === 'BAD_ENDPOINT') await sub.unsubscribe().catch(() => false);
    throw err;
  }
  assertCurrentSession(generation);
  writeRecord({ userId, space, endpoint: sub.endpoint, syncedAt: Date.now() });
  notifyDeviceChanged();
}

/** Switch off on this device: forget it on the server, then drop the browser's subscription. */
export async function disableOnThisDevice(): Promise<void> {
  const generation = tokenStore.generation();
  const sub = await browserSubscription();
  assertCurrentSession(generation);
  const endpoint = sub?.endpoint ?? readRecord()?.endpoint;
  try {
    if (endpoint) await pushApi.unsubscribe(endpoint);
  } finally {
    // Even when the server could not be reached: an unsubscribed endpoint answers 410 and the server drops it then.
    assertCurrentSession(generation);
    await withTimeout(sub?.unsubscribe() ?? Promise.resolve(false), LOGOUT_STEP_MS).catch(() => false);
    assertCurrentSession(generation);
    writeRecord(null);
    notifyDeviceChanged();
  }
}

/**
 * Logout (both spaces): DELETE /api/push/subscriptions, then subscription.unsubscribe(), so a shared device stops
 * receiving the previous user's pushes. Never throws and never waits long: the session ends anyway.
 */
export async function forgetThisDevice(accessToken: string | null = tokenStore.get()?.accessToken ?? null): Promise<void> {
  // Clear ownership before the first await, never in a late finally belonging to an old account.
  const record = readRecord();
  writeRecord(null);
  notifyDeviceChanged();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), LOGOUT_STEP_MS);
  try {
    if (record?.endpoint && accessToken) {
      await fetch('/api/push/subscriptions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ endpoint: record.endpoint }),
        signal: controller.signal,
        cache: 'no-store',
      }).catch(() => undefined);
    }
  } finally {
    window.clearTimeout(timer);
  }
  // A newer account may already be using this browser subscription. Do not unsubscribe it.
  if (tokenStore.get() || readRecord()) return;
  const sub = await withTimeout(browserSubscription(), LOGOUT_STEP_MS).catch(() => null);
  if (tokenStore.get() || readRecord()) return;
  if (sub && (!record || sub.endpoint === record.endpoint)) {
    await withTimeout(sub.unsubscribe(), LOGOUT_STEP_MS).catch(() => false);
  }
}

/**
 * App start (signed in): keep the server's copy of this device fresh, only when it was turned on by this user in this
 * space. Anything else found on the device is dropped (a session that ended without logging out, or the other space).
 */
export async function syncThisDevice(userId: string, space: PushSpace): Promise<void> {
  const generation = tokenStore.generation();
  if (pushAvailability() !== 'supported') return;
  const sub = await browserSubscription();
  assertCurrentSession(generation);
  const rec = readRecord();
  if (!sub) {
    if (rec) {
      // The browser dropped it (permission reset, storage cleared): tell the server when it was ours.
      if (isMine(rec, userId, space)) void pushApi.unsubscribe(rec.endpoint).catch(() => undefined);
      writeRecord(null);
      notifyDeviceChanged();
    }
    return;
  }
  if (!isMine(rec, userId, space) || Notification.permission !== 'granted') {
    if (isMine(rec, userId, space)) void pushApi.unsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
    assertCurrentSession(generation);
    writeRecord(null);
    notifyDeviceChanged();
    return;
  }
  const config = await pushApi.config().catch(() => null);
  assertCurrentSession(generation);
  if (!config?.enabled || !config.publicKey) return;
  // A new server key needs a new subscription; permission is already granted, so no prompt.
  const current = sameKey(sub.options.applicationServerKey, keyBytes(config.publicKey)) ? sub : await ensureBrowserSubscription(config.publicKey, generation);
  assertCurrentSession(generation);
  if (current.endpoint === rec.endpoint && Date.now() - rec.syncedAt < RESYNC_MS) return;
  if (current.endpoint !== rec.endpoint) void pushApi.unsubscribe(rec.endpoint).catch(() => undefined);
  await pushApi.subscribe(bodyOf(current, space));
  assertCurrentSession(generation);
  writeRecord({ userId, space, endpoint: current.endpoint, syncedAt: Date.now() });
  notifyDeviceChanged();
}

/** Only a same-origin path from the service worker moves the app (lw:navigate message). */
export function isAppPath(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') && url.length <= 300;
}
