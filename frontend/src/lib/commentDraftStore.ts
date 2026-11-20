import { tokenStore } from './tokenStore';

export interface CommentDraftScope {
  generation: string;
  userId: string;
  space: 'couple' | 'friends';
  coupleId: string;
  kind: 'story' | 'event';
  resourceId: string;
}
export interface CommentDraft {
  scope: CommentDraftScope;
  rootId: string | null;
  text: string;
  revision: string;
  updatedAt: number;
}
export interface DraftHandle { scope: CommentDraftScope; epoch: number }
const STORAGE_KEY = 'lw.commentDrafts.v1';
const TTL = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;
let entries: CommentDraft[] | undefined;
let version = 0;
let nextEpoch = 0;
const epochs = new Map<string, number>();
const listeners = new Set<() => void>();
const scopeKey = (s: CommentDraftScope) => JSON.stringify([s.generation, s.userId, s.space, s.coupleId, s.kind, s.resourceId]);
const validId = (s: unknown): s is string => typeof s === 'string' && s.length <= 160;
function validEntry(value: unknown): value is CommentDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as CommentDraft, s = d.scope;
  return !!s && [s.generation, s.userId, s.coupleId, s.resourceId].every(validId) &&
    (s.space === 'couple' || s.space === 'friends') && (s.kind === 'story' || s.kind === 'event') &&
    (d.rootId === null || validId(d.rootId)) && typeof d.text === 'string' && d.text.length <= 2000 &&
    validId(d.revision) && Number.isFinite(d.updatedAt) && d.updatedAt <= Date.now() && Date.now() - d.updatedAt < TTL;
}
function persist() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Memory-only when storage is unavailable/full. */ }
}
function load(): CommentDraft[] {
  if (!entries) {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
      entries = Array.isArray(raw) ? raw.filter(validEntry).slice(-MAX_ENTRIES).map(d => ({
        scope: { generation: d.scope.generation, userId: d.scope.userId, space: d.scope.space, coupleId: d.scope.coupleId, kind: d.scope.kind, resourceId: d.scope.resourceId },
        rootId: d.rootId, text: d.text, revision: d.revision, updatedAt: d.updatedAt,
      })) : [];
    } catch { entries = []; }
  }
  const retained = entries.filter(d => validEntry(d) && tokenStore.isCurrent(d.scope.generation));
  if (retained.length !== entries.length) { entries = retained; persist(); }
  return entries;
}
function publish() { persist(); version++; for (const listener of listeners) listener(); }
function current(handle: DraftHandle): boolean {
  return tokenStore.isCurrent(handle.scope.generation) && handle.epoch === epochs.get(scopeKey(handle.scope));
}
export const commentDraftStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  version: () => version,
  open(scope: CommentDraftScope): DraftHandle {
    const key = scopeKey(scope);
    if (!epochs.has(key)) epochs.set(key, ++nextEpoch);
    // Eviction invalidates old handles; monotonic epochs never resurrect them.
    while (epochs.size > 120) epochs.delete(epochs.keys().next().value!);
    return { scope, epoch: epochs.get(key)! };
  },
  read(handle: DraftHandle): CommentDraft | undefined {
    if (!current(handle)) return undefined;
    return load().filter(d => scopeKey(d.scope) === scopeKey(handle.scope)).at(-1);
  },
  write(handle: DraftHandle, text: string, rootId: string | null): CommentDraft | undefined {
    if (!current(handle)) return undefined;
    // A composer has one active destination; changing it is explicit, never an automatic reply-to-root fallback.
    entries = load().filter(d => scopeKey(d.scope) !== scopeKey(handle.scope));
    const draft: CommentDraft = { scope: { ...handle.scope }, text: text.slice(0, 2000), rootId, revision: crypto.randomUUID(), updatedAt: Date.now() };
    if (draft.text || draft.rootId) entries.push(draft);
    entries = entries.slice(-MAX_ENTRIES);
    publish();
    return draft.text ? draft : undefined;
  },
  clear(handle: DraftHandle, expected?: CommentDraft): boolean {
    if (!current(handle)) return false;
    const draft = this.read(handle);
    if (expected && draft?.revision !== expected.revision) return false;
    entries = load().filter(d => scopeKey(d.scope) !== scopeKey(handle.scope));
    const key = scopeKey(handle.scope);
    epochs.delete(key);
    publish();
    return true;
  },
  revoke(scope: CommentDraftScope) {
    const key = scopeKey(scope);
    epochs.delete(key);
    entries = load().filter(d => scopeKey(d.scope) !== key);
    publish();
  },
  sessionChanged() {
    // Old handles also fail the persistent login-generation check, even after reload/token rotation.
    entries = load().filter(d => tokenStore.isCurrent(d.scope.generation));
    publish();
  },
  revokeCouple(generation: string, userId: string, coupleId: string) {
    for (const draft of [...load()]) if (draft.scope.generation === generation && draft.scope.userId === userId && draft.scope.coupleId === coupleId && draft.scope.space === 'couple') this.revoke(draft.scope);
  },
};
