import type { Response } from 'express';

/** Wire protocol v1 carries invalidation hints only; REST remains authoritative. */
export const REALTIME_DOMAINS = [
  'account', 'couple', 'pairing', 'quests', 'wallet', 'water', 'market', 'proposals', 'stories', 'story-unread',
  'questions', 'events', 'letters', 'moods', 'bucket', 'moments', 'savings', 'finance', 'assistant',
  'friends', 'friend-posts', 'friend-events', 'friend-outings', 'friend-notifications', 'friend-profile',
] as const;
export type RealtimeDomain = (typeof REALTIME_DOMAINS)[number];
export type RealtimeSpace = 'couple' | 'friends';
const domainSet = new Set<string>(REALTIME_DOMAINS);
const MAX_CONNECTIONS = 2000;
const MAX_PER_USER = 10;
const MAX_PER_SPACE = 5;
const MAX_BUFFER_BYTES = 16 * 1024;
const HEARTBEAT_MS = 20_000;
const MAX_LIFETIME_MS = 10 * 60_000;

type Subscriber = {
  userId: string; space: RealtimeSpace; res: Response; closed: boolean; deadline: number;
  domains: Set<RealtimeDomain>; access: boolean; wholeAccess: boolean; scheduled: boolean;
  heartbeat?: ReturnType<typeof setInterval>; expiry?: ReturnType<typeof setTimeout>;
  close: () => void;
};
const subscribers = new Set<Subscriber>();
let draining = false;

function frame(event: 'ready' | 'dirty' | 'access', domains: RealtimeDomain[]): string {
  return `event: ${event}\ndata: ${JSON.stringify({ version: 1, domains })}\n\n`;
}
function write(sub: Subscriber, data: string): void {
  if (sub.closed) return;
  if (Date.now() >= sub.deadline || sub.res.destroyed || sub.res.writableEnded) { sub.close(); return; }
  try {
    // Never queue an unbounded stream for a stalled client. A reconnect performs a full resync.
    if (sub.res.writableLength + Buffer.byteLength(data) > MAX_BUFFER_BYTES || !sub.res.write(data)) sub.close();
  } catch { sub.close(); }
}

export const realtimeService = {
  /** Register first, then send ready so a ready-time resync has no registration gap. */
  subscribe(userId: string, space: RealtimeSpace, res: Response, expiresAtMs: number): boolean {
    if (draining || subscribers.size >= MAX_CONNECTIONS || !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= Date.now() || res.destroyed || res.writableEnded) return false;
    let userCount = 0, spaceCount = 0;
    for (const existing of subscribers) if (existing.userId === userId) {
      userCount++;
      if (existing.space === space) spaceCount++;
    }
    if (userCount >= MAX_PER_USER || spaceCount >= MAX_PER_SPACE) return false;
    const sub: Subscriber = {
      userId, space, res, closed: false, deadline: Math.min(expiresAtMs, Date.now() + MAX_LIFETIME_MS),
      domains: new Set(), access: false, wholeAccess: false, scheduled: false,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        subscribers.delete(sub);
        if (sub.heartbeat) clearInterval(sub.heartbeat);
        if (sub.expiry) clearTimeout(sub.expiry);
        res.removeListener('close', sub.close);
        res.removeListener('error', sub.close);
        if (!res.writableEnded && !res.destroyed) res.end();
      },
    };
    subscribers.add(sub);
    res.once('close', sub.close);
    res.once('error', sub.close);
    sub.heartbeat = setInterval(() => write(sub, ': heartbeat\n\n'), HEARTBEAT_MS);
    sub.expiry = setTimeout(sub.close, Math.max(0, sub.deadline - Date.now()));
    write(sub, frame('ready', []));
    return true;
  },
  /** Synchronous, best-effort hint. No IDs, content, or actor data enter the frame. */
  publish(userIds: Iterable<string>, space: RealtimeSpace, domains: RealtimeDomain[], access = false): void {
    try {
      const recipients = new Set(userIds);
      const safeDomains = domains.filter((domain) => domainSet.has(domain));
      // An explicitly empty access hint revokes the entire current scope. Invalid domain
      // values alone must not accidentally be promoted into a whole-scope revocation.
      const wholeAccess = access && domains.length === 0;
      if (!safeDomains.length && !wholeAccess) return;
      for (const sub of subscribers) {
        if (sub.closed || sub.space !== space || !recipients.has(sub.userId)) continue;
        for (const domain of safeDomains) sub.domains.add(domain);
        sub.access ||= access;
        sub.wholeAccess ||= wholeAccess;
        if (sub.scheduled) continue;
        sub.scheduled = true;
        queueMicrotask(() => {
          sub.scheduled = false;
          if (sub.closed || (!sub.domains.size && !sub.wholeAccess)) return;
          const pending = sub.wholeAccess ? [] : [...sub.domains];
          const event = sub.access ? 'access' : 'dirty';
          sub.domains.clear(); sub.access = false; sub.wholeAccess = false;
          write(sub, frame(event, pending));
        });
      }
    } catch { /* delivery is never allowed to fail a committed mutation */ }
  },
  /** Stop accepting streams and end current streams before http.Server.close(). */
  drain(): void {
    draining = true;
    for (const sub of [...subscribers]) sub.close();
  },
};

/** In-process delivery cannot support multiple workers. Independent replicas require deployment controls. */
export function assertSingleRealtimeProcess(vars: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['WEB_CONCURRENCY', 'PM2_INSTANCES', 'NODE_APP_INSTANCE_COUNT']) {
    const value = vars[name];
    if (value && (!/^\d+$/.test(value) || Number(value) > 1)) throw new Error(`Realtime requires one API process: ${name}`);
  }
  // PM2 assigns 0 to the first worker. The local all-mock verification harness uses
  // instance 1 solely to suppress background jobs, not as a PM2 worker.
  const mockVerification = vars.NODE_ENV === 'development' && vars.STORAGE_PROVIDER === 'memory' &&
    vars.AI_PROVIDER === 'mock' && vars.BANK_PROVIDER === 'mock' && vars.PUSH_PROVIDER === 'mock';
  if (vars.NODE_APP_INSTANCE && vars.NODE_APP_INSTANCE !== '0' && vars.NODE_ENV !== 'test' && !mockVerification) {
    throw new Error('Realtime requires one API process: NODE_APP_INSTANCE');
  }
}
