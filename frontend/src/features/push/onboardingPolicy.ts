/** Presentation policy only: never reads credentials, requests permission, or grants push consent. */
const PREFIX = 'lw.push.onboarding.v1.';
const DAY = 24 * 60 * 60 * 1000;
const DISMISS_MS = 7 * DAY;
// A crashed tab must not reserve the invitation forever. Cross-tab exclusion is best effort.
const CLAIM_MS = 5 * 60 * 1000;
const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type Permission = 'default' | 'granted' | 'denied';
export type OnboardingFinishReason = 'later' | 'failure' | 'denied' | 'success' | 'interrupted' | 'unavailable';
interface Claim {
  owner: string;
  generation: string;
  permission: Permission;
  until: number;
}
interface Policy {
  version: 1;
  explicitlyOff: boolean;
  cooldownUntil: number;
  deniedHelpShown: boolean;
  permission: Permission | null;
  // Opaque login identity, NOT an access/refresh token. Older identities are retained in document memory.
  consumedGeneration: string | null;
  active: Claim | null;
}
interface Entry {
  policy: Policy;
  raw: string | null;
  dirty: boolean;
  consumed: Set<string>;
  owned: Claim | null;
  mutation: number;
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0;
let listening = false;

const keyOf = (userId: string) => `${PREFIX}${encodeURIComponent(userId)}`;
const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const permissionOf = (value: unknown): Permission | null =>
  value === 'default' || value === 'granted' || value === 'denied' ? value : null;
const empty = (): Policy => ({
  version: 1, explicitlyOff: false, cooldownUntil: 0, deniedHelpShown: false,
  permission: null, consumedGeneration: null, active: null,
});

function deadline(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, Date.now() + maximum) : 0;
}

function parse(raw: string | null): Policy {
  if (!raw) return empty();
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1) return empty();
    const active = value.active;
    const permission = permissionOf(active?.permission);
    return {
      version: 1,
      explicitlyOff: value.explicitlyOff === true,
      cooldownUntil: deadline(value.cooldownUntil, DISMISS_MS),
      deniedHelpShown: value.deniedHelpShown === true,
      permission: permissionOf(value.permission),
      consumedGeneration: validIdentity(value.consumedGeneration) ? value.consumedGeneration : null,
      active: active && validIdentity(active.owner) && validIdentity(active.generation) && permission
        && deadline(active.until, CLAIM_MS) > Date.now()
        ? { owner: active.owner, generation: active.generation, permission, until: deadline(active.until, CLAIM_MS) }
        : null,
    };
  } catch {
    return empty();
  }
}

function notify(): void {
  revision += 1;
  for (const listener of listeners) {
    try { listener(); } catch { /* One observer cannot prevent policy persistence or other observers. */ }
  }
}

function refresh(userId: string, entry: Entry): void {
  // A failed write must never let stale persisted state undo a choice made in this document.
  if (entry.dirty) return;
  try {
    const raw = localStorage.getItem(keyOf(userId));
    if (raw === entry.raw) return;
    entry.raw = raw;
    entry.policy = parse(raw);
    if (entry.policy.consumedGeneration) entry.consumed.add(entry.policy.consumedGeneration);
    if (entry.owned && (entry.policy.active?.owner !== owner
      || entry.policy.active.generation !== entry.owned.generation)) entry.owned = null;
  } catch { /* Storage unavailable: retain the in-memory policy. */ }
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  try {
    window.addEventListener('storage', event => {
      if (event.key !== null && !event.key.startsWith(PREFIX)) return;
      // Ignore sessionStorage events; accessing localStorage itself can throw in privacy modes.
      try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { /* Best effort. */ }
      for (const [userId, entry] of entries) {
        if (event.key === null || event.key === keyOf(userId)) refresh(userId, entry);
      }
      notify();
    });
    listening = true;
  } catch { /* Non-browser/test environments need only the memory store. */ }
}

function read(userId: string): Entry {
  listen();
  let entry = entries.get(userId);
  if (!entry) {
    entry = { policy: empty(), raw: null, dirty: false, consumed: new Set(), owned: null, mutation: 0 };
    entries.set(userId, entry);
  }
  refresh(userId, entry);
  return entry;
}

function save(userId: string, entry: Entry): void {
  entry.mutation += 1;
  entry.dirty = true;
  try {
    const raw = JSON.stringify(entry.policy);
    localStorage.setItem(keyOf(userId), raw);
    entry.raw = raw;
    entry.dirty = false;
  } catch { /* Memory remains authoritative even when storage is denied or full. */ }
  notify();
}

function active(entry: Entry): boolean {
  // A live local presentation remains reserved even if a slow OS prompt outlasts the cross-tab lease.
  return entry.owned !== null || (entry.policy.active?.until ?? 0) > Date.now();
}

function eligible(entry: Entry): boolean {
  return !entry.policy.explicitlyOff && entry.policy.cooldownUntil <= Date.now() && !active(entry);
}

export function subscribeOnboarding(listener: () => void): () => void {
  listen();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onboardingVersion(): number { return revision; }

/** Shared arbitration for the old action-triggered card; this never consumes an auth generation. */
export function canSuggestPush(userId: string, permission?: string): boolean {
  if (!validIdentity(userId)) return false;
  const entry = read(userId);
  return eligible(entry) && !(permission === 'denied' && entry.policy.permission === 'denied' && entry.policy.deniedHelpShown);
}

export function isPushExplicitlyOff(userId: string): boolean {
  return validIdentity(userId) && read(userId).policy.explicitlyOff;
}

/** Call only once readiness is established. The lock covers reservation, never UI or the OS prompt. */
export async function claimOnboarding(userId: string, generation: string, permission: string): Promise<boolean> {
  const currentPermission = permissionOf(permission);
  if (!validIdentity(userId) || !validIdentity(generation) || !currentPermission) return false;
  const entry = read(userId);
  const mutation = entry.mutation;
  const reserve = (): boolean => {
    refresh(userId, entry);
    // A manual enable/off or completed presentation while waiting for the lock supersedes this request.
    if (entry.mutation !== mutation) return false;
    const policy = entry.policy;
    if (policy.permission !== currentPermission) {
      policy.permission = currentPermission;
      policy.deniedHelpShown = false;
      save(userId, entry);
    }
    if (!eligible(entry) || entry.consumed.has(generation)
      || policy.consumedGeneration === generation
      || (currentPermission === 'denied' && policy.deniedHelpShown)) return false;
    const claim: Claim = { owner, generation, permission: currentPermission, until: Date.now() + CLAIM_MS };
    entry.owned = claim;
    entry.consumed.add(generation);
    policy.consumedGeneration = generation;
    policy.active = claim;
    save(userId, entry);
    return true;
  };
  // Some embedded/private browsers expose Web Locks but reject access. Fall back to a synchronous
  // memory/storage claim; without shared storage + locks, cross-tab exclusion cannot be guaranteed.
  let attempted = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(keyOf(userId), () => {
        attempted = true;
        return reserve();
      });
    }
  } catch {
    if (attempted) return false;
  }
  return reserve();
}

/** A stale/unowned cleanup cannot dismiss or release a newer presentation. */
export function finishOnboarding(userId: string, generation: string, reason: OnboardingFinishReason): void {
  if (!validIdentity(userId)) return;
  const entry = read(userId);
  const claim = entry.owned;
  if (!claim || claim.generation !== generation) return;
  const policy = entry.policy;
  entry.owned = null;
  policy.active = null;
  if (reason === 'success') {
    policy.explicitlyOff = false;
    policy.cooldownUntil = 0;
    policy.deniedHelpShown = false;
  } else {
    if (reason === 'later') policy.cooldownUntil = Date.now() + DISMISS_MS;
    if (reason === 'failure') policy.cooldownUntil = Date.now() + DAY;
    if (reason === 'denied' || claim.permission === 'denied') {
      policy.deniedHelpShown = true;
      policy.permission = 'denied';
    }
    // Interrupted/unavailable consume this auth opportunity but do not impose a timed cooldown.
  }
  save(userId, entry);
}

/** Only an explicit settings OFF action should call this, never logout or subscription repair. */
export function setPushExplicitlyOff(userId: string): void {
  if (!validIdentity(userId)) return;
  const entry = read(userId);
  entry.policy.explicitlyOff = true;
  entry.policy.active = null;
  entry.owned = null;
  save(userId, entry);
}

/** Successful manual enable clears suppression; it does not erase consumed login identities. */
export function recordPushEnabled(userId: string): void {
  if (!validIdentity(userId)) return;
  const entry = read(userId);
  entry.policy.explicitlyOff = false;
  entry.policy.cooldownUntil = 0;
  entry.policy.deniedHelpShown = false;
  entry.policy.permission = 'granted';
  entry.policy.active = null;
  entry.owned = null;
  save(userId, entry);
}
