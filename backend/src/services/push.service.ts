import { Types } from 'mongoose';
import { COUPLE_PUSH_GROUPS, FRIENDS_PUSH_GROUPS } from '../config/notificationTypes.js';
import { getPush } from '../integrations/index.js';
import type { PushSendOptions } from '../integrations/push/PushProvider.js';
import type { PushSpace } from '../models/PushSubscription.js';
import { DEFAULT_PUSH_SETTINGS, type PushSettings } from '../models/User.js';
import { pushSubscriptionRepository, type PushSubscriptionRow } from '../repositories/pushSubscription.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { getLocalTime } from '../utils/date.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Web Push (plan/OPERATIONS.md, N4). Services never call this directly: notificationService.emit() is the single entry
// point and passes the push here. Sending runs in the background (not awaited by the request or the job), so a slow or
// failing push service never slows or fails the action that caused it. Notification text is never logged.

/** What the lock screen shows for one event (the friends space hides it unless "Hiện nội dung" is on). */
export interface PushContent {
  /** Text under the title. A function receives the actor's name: given name in the couple app ("Hà"), full name for friends. */
  body: string | ((actorName: string) => string);
  /** Same-origin path opened on tap, e.g. `/stories/<id>`. */
  url: string;
  /** Same tag = the new notification replaces the older one on the device (e.g. `story:<id>`). */
  tag?: string;
}

export interface PushJob {
  userId: Types.ObjectId;
  space: PushSpace;
  /** Settings group of the type (config/notificationTypes.ts). */
  group: string;
  /** For logs only. */
  type: string;
  actorId: Types.ObjectId | null;
  content: PushContent;
  /** Timed reminder: TTL 4 h instead of 24 h. */
  timed?: boolean;
  urgent?: boolean;
}

/** The payload the service worker reads (frontend/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  /** App icon badge count (setAppBadge). No type sends it yet. */
  badge?: number;
}

export interface PushSettingsView {
  space: PushSpace;
  groups: Record<string, boolean>;
  preview: boolean;
  quiet: PushSettings['quiet'];
}

const APP_NAME = 'Look Within';
/** Shown instead of the content when "Hiện nội dung" is off (default in the friends space). Never names a space. */
export const HIDDEN_BODY = 'Bạn có thông báo mới';
const TTL_TIMED_SEC = 4 * 3600;
const TTL_DEFAULT_SEC = 24 * 3600;
/** Devices of one user in one space reached in parallel. */
const PER_USER_PARALLEL = 5;
/** Deliveries running at once in this process; more wait their turn in RAM (bounded). */
const MAX_IN_FLIGHT = 10;
const MAX_PENDING = 2000;
/** Failed sends in a row (not 404/410) before a device is dropped. */
export const MAX_FAILS = 5;
/** Devices kept per user and space (oldest dropped first). */
const MAX_DEVICES = 10;
const MAX_TITLE = 60;
const MAX_BODY = 180;
const MAX_URL = 300;
/** Web Push allows about 4 KB of encrypted payload; stay well under it. */
const MAX_PAYLOAD_BYTES = 3000;

/**
 * Hosts of the browsers' push services (Chrome/Samsung/Opera/Brave, Firefox, Safari, Edge). Anything else is refused (no SSRF).
 * jmt17.google.com: Google's endpoint for Chromium builds without Google API keys (seen with Playwright's Chromium).
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'jmt17.google.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

const SETTINGS_URL: Record<PushSpace, string> = { couple: '/profile/notifications', friends: '/friends/me/notifications' };
const GROUPS: Record<PushSpace, readonly string[]> = { couple: COUPLE_PUSH_GROUPS, friends: FRIENDS_PUSH_GROUPS };

const disabled = () => new AppError(503, 'PUSH_DISABLED', 'Máy chủ chưa bật thông báo.');

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/** "iPhone · Safari", "Android · Chrome"… (stored instead of the full user agent). */
export function shortUserAgent(ua = ''): string {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|CrOS/.test(ua)
              ? 'Linux'
              : 'Máy khác';
  const browser = /EdgA?\/|EdgiOS/.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /OPR\//.test(ua)
          ? 'Opera'
          : /CriOS|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\/|iPhone|iPad|Macintosh/.test(ua)
              ? 'Safari'
              : 'Trình duyệt';
  return `${device} · ${browser}`;
}

/** Stored settings over the defaults (older accounts miss fields; wrong types are ignored). */
export function resolvePushSettings(raw: Partial<PushSettings> | null | undefined): PushSettings {
  const pick = <T extends Record<string, boolean | string>>(defaults: T, value: unknown): T => {
    const src = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      if (typeof src[key as string] === typeof defaults[key]) out[key] = src[key as string] as T[keyof T];
    }
    return out;
  };
  return {
    couple: pick(DEFAULT_PUSH_SETTINGS.couple, raw?.couple),
    friends: pick(DEFAULT_PUSH_SETTINGS.friends, raw?.friends),
    quiet: pick(DEFAULT_PUSH_SETTINGS.quiet, raw?.quiet),
  };
}

/** Inside the quiet hours at `now` in `timezone` ("23:00"–"07:00" wraps past midnight; from = to means never). */
export function inQuietHours(quiet: PushSettings['quiet'], timezone: string | undefined, now: Date): boolean {
  if (!quiet.enabled || quiet.from === quiet.to) return false;
  let t: string;
  try {
    t = getLocalTime(now, timezone || 'Asia/Ho_Chi_Minh');
  } catch {
    t = getLocalTime(now, 'Asia/Ho_Chi_Minh');
  }
  return quiet.from < quiet.to ? t >= quiet.from && t < quiet.to : t >= quiet.from || t < quiet.to;
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Only a same-origin path ever reaches the service worker. */
function safePath(url: string, space: PushSpace): string {
  return url.startsWith('/') && !url.startsWith('//') && url.length <= MAX_URL ? url : space === 'friends' ? '/friends' : '/';
}

/** Payload as JSON, at most MAX_PAYLOAD_BYTES (the body is cut further if needed). */
function encode(p: PushPayload): string {
  let json = JSON.stringify(p);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) json = JSON.stringify({ ...p, body: clip(p.body, 60), tag: p.tag?.slice(0, 64) });
  return json;
}

function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || displayName;
}

async function actorName(actorId: Types.ObjectId, space: PushSpace): Promise<string> {
  const name = (await userRepository.findDisplayNames([actorId])).get(actorId.toString());
  if (!name) return space === 'couple' ? 'Người ấy' : 'Một người bạn';
  return space === 'couple' ? shortName(name) : name;
}

async function buildPayload(job: PushJob, preview: boolean): Promise<PushPayload> {
  if (!preview) {
    // One collapsed "Bạn có thông báo mới" per space. Friends: the list page, so nothing about the event is in the payload.
    return job.space === 'friends'
      ? { title: APP_NAME, body: HIDDEN_BODY, url: '/friends/notifications', tag: 'friends' }
      : { title: APP_NAME, body: HIDDEN_BODY, url: safePath(job.content.url, job.space), tag: 'couple' };
  }
  const raw = job.content.body;
  const body = typeof raw === 'function' ? raw(job.actorId ? await actorName(job.actorId, job.space) : '') : raw;
  return { title: clip(APP_NAME, MAX_TITLE), body: clip(body, MAX_BODY), url: safePath(job.content.url, job.space), tag: job.content.tag?.slice(0, 100) };
}

interface SendStats {
  ok: number;
  gone: number;
  failed: number;
}

async function sendOne(sub: PushSubscriptionRow, payload: string, opts: PushSendOptions, ctx: { userId: string; type: string }, stats: SendStats): Promise<void> {
  const result = await getPush().send({ endpoint: sub.endpoint, keys: sub.keys }, payload, opts);
  if (result.status === 'ok') {
    stats.ok += 1;
    await pushSubscriptionRepository.markSuccess(sub._id);
    return;
  }
  const host = (() => {
    try {
      return new URL(sub.endpoint).hostname;
    } catch {
      return '?';
    }
  })();
  if (result.status === 'gone') {
    stats.gone += 1;
    await pushSubscriptionRepository.deleteById(sub._id);
    logger.info('Push device gone, removed', { ...ctx, host, statusCode: result.statusCode });
    return;
  }
  stats.failed += 1;
  const fails = await pushSubscriptionRepository.incFail(sub._id);
  if (fails !== null && fails >= MAX_FAILS) {
    await pushSubscriptionRepository.deleteById(sub._id);
    logger.warn('Push device removed after repeated failures', { ...ctx, host, statusCode: result.statusCode, fails });
  } else {
    logger.warn('Push send failed', { ...ctx, host, statusCode: result.statusCode, fails, message: result.message.slice(0, 200) });
  }
}

async function sendToAll(subs: PushSubscriptionRow[], payload: PushPayload, opts: PushSendOptions, ctx: { userId: string; type: string }): Promise<SendStats> {
  const json = encode(payload);
  const stats: SendStats = { ok: 0, gone: 0, failed: 0 };
  for (let i = 0; i < subs.length; i += PER_USER_PARALLEL) {
    await Promise.all(subs.slice(i, i + PER_USER_PARALLEL).map((s) => sendOne(s, json, opts, ctx, stats)));
  }
  return stats;
}

/** One event to one user: devices of that space, settings group, quiet hours, preview, then send. */
async function deliver(job: PushJob): Promise<void> {
  const subs = await pushSubscriptionRepository.listFor(job.userId, job.space);
  if (subs.length === 0) return;
  const profile = await userRepository.findPushProfile(job.userId);
  if (!profile) return;
  const settings = resolvePushSettings(profile.pushSettings);
  const own = settings[job.space] as Record<string, boolean>;
  const ctx = { userId: job.userId.toString(), type: job.type };
  if (own[job.group] === false) {
    logger.debug('Push skipped: group off', { ...ctx, group: job.group });
    return;
  }
  if (inQuietHours(settings.quiet, profile.timezone, new Date())) {
    logger.debug('Push skipped: quiet hours', ctx);
    return;
  }
  const payload = await buildPayload(job, own.preview === true);
  const stats = await sendToAll(subs, payload, { ttlSec: job.timed ? TTL_TIMED_SEC : TTL_DEFAULT_SEC, urgency: job.urgent ? 'high' : 'normal' }, ctx);
  logger.debug('Push sent', { ...ctx, devices: subs.length, ...stats });
}

// In-process limiter: at most MAX_IN_FLIGHT deliveries at once, the rest wait in RAM (no queue service).
let pending = 0;
let active = 0;
const waiting: (() => void)[] = [];
let droppedWarned = false;

async function run(job: PushJob): Promise<void> {
  if (active >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    await deliver(job);
  } catch (err) {
    logger.warn('Push not sent', { userId: job.userId.toString(), type: job.type, message: (err as Error).message });
  } finally {
    active -= 1;
    pending -= 1;
    waiting.shift()?.();
  }
}

function viewOf(settings: PushSettings, space: PushSpace): PushSettingsView {
  const own = settings[space] as Record<string, boolean>;
  return {
    space,
    groups: Object.fromEntries(GROUPS[space].map((g) => [g, own[g] !== false])),
    preview: own.preview === true,
    quiet: { ...settings.quiet },
  };
}

async function requireSpaceAccess(userId: string, space: PushSpace): Promise<void> {
  if (space === 'friends' && !(await userRepository.isFriendsMember(userId))) {
    throw new AppError(403, 'FRIENDS_NOT_JOINED', 'Bạn chưa tham gia Hội bạn bè');
  }
}

export const pushService = {
  /**
   * Send in the background. Returns at once; the counter is taken now, so a test reading /api/dev-push right after the
   * response sees the push as pending until it is done.
   */
  enqueue(job: PushJob): void {
    if (!getPush().enabled) return;
    if (pending >= MAX_PENDING) {
      if (!droppedWarned) logger.warn('Push backlog full, dropping pushes', { pending });
      droppedWarned = true;
      return;
    }
    droppedWarned = false;
    pending += 1;
    void run(job);
  },

  /** Deliveries scheduled and not finished yet (dev endpoint). */
  pendingCount(): number {
    return pending;
  },

  config(): { enabled: boolean; publicKey: string | null } {
    const p = getPush();
    return { enabled: p.enabled, publicKey: p.enabled ? p.publicKey : null };
  },

  /** Save this device for the caller in the session's space (moves it from another user or space). */
  async subscribe(userId: string, input: { endpoint: string; keys: { p256dh: string; auth: string }; space: PushSpace }, userAgent: string | undefined) {
    if (!getPush().enabled) throw disabled();
    if (!isPushEndpoint(input.endpoint)) throw new AppError(400, 'BAD_ENDPOINT', 'Địa chỉ nhận thông báo không hợp lệ');
    await requireSpaceAccess(userId, input.space);
    const uid = new Types.ObjectId(userId);
    const device = shortUserAgent(userAgent);
    await pushSubscriptionRepository.upsert({ userId: uid, space: input.space, endpoint: input.endpoint, keys: input.keys, userAgent: device });
    const pruned = await pushSubscriptionRepository.pruneOldest(uid, input.space, MAX_DEVICES);
    logger.info('Push device saved', { userId, space: input.space, device, pruned });
    return { space: input.space, device };
  },

  /** Logout or switch off: forget this device. Idempotent; another user's endpoint is never touched. */
  async unsubscribe(userId: string, endpoint: string): Promise<{ removed: boolean }> {
    const removed = await pushSubscriptionRepository.deleteOwn(new Types.ObjectId(userId), endpoint);
    if (removed) logger.info('Push device removed', { userId });
    return { removed };
  },

  async getSettings(userId: string, space: PushSpace): Promise<PushSettingsView> {
    await requireSpaceAccess(userId, space);
    const profile = await userRepository.findPushProfile(userId);
    return viewOf(resolvePushSettings(profile?.pushSettings), space);
  },

  async updateSettings(
    userId: string,
    patch: { space: PushSpace; groups?: Record<string, boolean | undefined>; preview?: boolean; quiet?: Partial<PushSettings['quiet']> },
  ): Promise<PushSettingsView> {
    const { space } = patch;
    await requireSpaceAccess(userId, space);
    const current = resolvePushSettings((await userRepository.findPushProfile(userId))?.pushSettings);
    const quiet = { ...current.quiet, ...Object.fromEntries(Object.entries(patch.quiet ?? {}).filter(([, v]) => v !== undefined)) };
    if (quiet.from === quiet.to) throw new AppError(400, 'BAD_QUIET_HOURS', 'Giờ bắt đầu và giờ kết thúc phải khác nhau');
    const fields: Record<string, boolean | string> = {};
    for (const [g, v] of Object.entries(patch.groups ?? {})) if (typeof v === 'boolean' && GROUPS[space].includes(g)) fields[`${space}.${g}`] = v;
    if (patch.preview !== undefined) fields[`${space}.preview`] = patch.preview;
    for (const [k, v] of Object.entries(patch.quiet ?? {})) if (v !== undefined) fields[`quiet.${k}`] = v;
    await userRepository.setPushSettings(userId, fields);
    logger.info('Push settings changed', { userId, space, fields: Object.keys(fields) });
    const after = resolvePushSettings((await userRepository.findPushProfile(userId))?.pushSettings);
    return viewOf(after, space);
  },

  /** "Gửi thử": to this device only, right now (no group switch, no quiet hours). */
  async test(userId: string, endpoint: string): Promise<{ sent: true }> {
    if (!getPush().enabled) throw disabled();
    const uid = new Types.ObjectId(userId);
    const sub = await pushSubscriptionRepository.findOwn(uid, endpoint);
    if (!sub) throw new AppError(404, 'PUSH_NOT_SUBSCRIBED', 'Máy này chưa bật thông báo');
    const payload: PushPayload = {
      title: APP_NAME,
      body: 'Thông báo thử: máy này đã nhận được thông báo ✅',
      url: SETTINGS_URL[sub.space],
      tag: 'test',
    };
    const stats = await sendToAll([sub], payload, { ttlSec: 600, urgency: 'normal' }, { userId, type: 'test' });
    if (stats.gone) throw new AppError(410, 'PUSH_GONE', 'Máy này không còn nhận được thông báo. Hãy bật lại.');
    if (stats.failed) throw new AppError(502, 'PUSH_FAILED', 'Chưa gửi được thông báo thử, thử lại sau nhé.');
    return { sent: true };
  },
};
