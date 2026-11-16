import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { Space } from '../../lib/spaceStore';
import { advanceAccessEpoch, ApiRequestError } from '../../lib/apiClient';
import { DOMAINS, type Domain } from './parser';

const map: Record<Domain, readonly QueryKey[]> = {
  account: [['couple']],
  couple: [['couple'], ['quests'], ['checkin'], ['wallet'], ['ledger'], ['proposals']],
  pairing: [['pairing'], ['couple']],
  quests: [['quests'], ['checkin'], ['couple']],
  wallet: [['wallet'], ['ledger'], ['quests'], ['couple']],
  water: [['water'], ['quests'], ['couple'], ['proposals']],
  market: [['market'], ['wallet'], ['ledger'], ['quests'], ['couple']],
  proposals: [['proposals'], ['couple'], ['water'], ['savings'], ['quests']],
  stories: [['stories'], ['couple']],
  'story-unread': [['stories', 'unread']],
  'couple-notifications': [['couple-notifications']],
  'couple-notification-unread': [['couple-notification-unread']],
  questions: [['questions'], ['quests'], ['couple']],
  events: [['events'], ['couple']],
  letters: [['letters'], ['couple']],
  moods: [['moods'], ['couple']],
  bucket: [['bucket'], ['quests'], ['couple']],
  moments: [['moments'], ['quests'], ['couple']],
  savings: [['savings'], ['proposals'], ['couple']],
  finance: [['finance']],
  assistant: [['finance', 'assistant']],
  friends: [['friends']],
  'friend-posts': [['friends', 'feed'], ['friends', 'story'], ['friends', 'comments'], ['friends', 'user-stories'], ['friends', 'poll-voters'], ['friends', 'reactions'], ['friends', 'mentionable']],
  'friend-events': [['friends', 'events'], ['friends', 'event'], ['friends', 'event-comments'], ['friends', 'event-mentionable']],
  'friend-outings': [['friends', 'outings'], ['friends', 'outing']],
  'friend-notifications': [['friends', 'notifications'], ['friends', 'unread']],
  'friend-profile': [['friends', 'profile'], ['friends', 'user-friends'], ['friends', 'user-stories'], ['friends', 'overview'], ['friends', 'search'], ['friends', 'suggestions']],
};
const coupleDomains = DOMAINS.filter((d) => !d.startsWith('friend') && d !== 'friends');
const friendDomains = DOMAINS.filter((d) => d.startsWith('friend') || d === 'account');

export function scopeDomains(space: Space): readonly Domain[] {
  return space === 'friends' ? friendDomains : coupleDomains;
}

export function queryPrefixes(domains: Iterable<Domain>): QueryKey[] {
  const result: QueryKey[] = [];
  for (const domain of domains) for (const key of map[domain]) {
    if (result.some((parent) => parent.length <= key.length && parent.every((part, i) => part === key[i]))) continue;
    for (let i = result.length - 1; i >= 0; i--) {
      if (key.length <= result[i].length && key.every((part, n) => part === result[i][n])) result.splice(i, 1);
    }
    result.push(key);
  }
  return result;
}

export function needsMe(domains: Iterable<Domain>): boolean {
  for (const domain of domains) if (['account', 'couple', 'pairing', 'wallet', 'quests'].includes(domain)) return true;
  return false;
}

export function invalidateDomains(qc: QueryClient, domains: Iterable<Domain>, space?: Space): void {
  const keys = queryPrefixes(domains).filter((key) => !space || (space === 'friends' ? key[0] === 'friends' : key[0] !== 'friends'));
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

/** Cancel first, then synchronously reset retained data before active REST refetches.
 * Query cancellation prevents even query functions that ignore AbortSignal from committing old results.
 * Restricted outings are not removed: their active query is rehydrated through the normal REST ACL. */
export function revokeDomains(qc: QueryClient, space: Space, domains: readonly Domain[]): void {
  advanceAccessEpoch();
  const relevant = domains.length ? [...domains] : [...scopeDomains(space)];
  if (space === 'friends' && relevant.includes('account') && !relevant.includes('friends')) relevant.push('friend-profile');
  const keys = queryPrefixes(relevant).filter((key) => space === 'friends' ? key[0] === 'friends' : key[0] !== 'friends');
  for (const queryKey of keys) void qc.cancelQueries({ queryKey });
  for (const queryKey of keys) void qc.resetQueries({ queryKey });
}

/** Revalidate all currently observed private data while the route tree is masked.
 * Unobserved caches are removed so a later mount cannot show a stale private snapshot. */
export async function verifyScope(qc: QueryClient, space: Space, valid: () => boolean): Promise<boolean> {
  const keys = queryPrefixes(scopeDomains(space)).filter((key) => space === 'friends' ? key[0] === 'friends' : key[0] !== 'friends');
  const matches = (query: { queryKey: QueryKey }) => keys.some((key) => key.length <= query.queryKey.length && key.every((part, i) => part === query.queryKey[i]));
  const filters = { predicate: matches };
  await qc.cancelQueries(filters);
  if (!valid()) return false;
  // Disabled observers may hold sensitive data too: remove it before unmasking.
  qc.removeQueries({ ...filters, predicate: (query) => matches(query) && query.getObserversCount() === 0 });
  // Observed but disabled queries are not refetched; clear them in place so a later
  // enabled observer cannot reveal stale data.
  for (const query of qc.getQueryCache().findAll({ ...filters, type: 'inactive' })) query.reset();
  const queries = qc.getQueryCache().findAll({ ...filters, type: 'active' });
  const results = await Promise.all(queries.map(async (query) => {
    try {
      await qc.refetchQueries({ queryKey: query.queryKey, exact: true, type: 'active' }, { throwOnError: true });
      return query.state.fetchStatus !== 'paused';
    } catch (error) {
      if (!valid()) return false;
      if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
        // Keep an error state but never the old successful payload. A reset+refetch
        // leaves the 403/404 visible rather than leaving a stale successful value.
        await qc.resetQueries({ queryKey: query.queryKey, exact: true }, { throwOnError: false });
        return query.state.data !== undefined || (query.state.error instanceof ApiRequestError &&
          (query.state.error.status === 403 || query.state.error.status === 404));
      }
      return false;
    }
  }));
  if (!valid() || !results.every(Boolean)) return false;
  // Re-rendering can activate another dependent query while verification is in flight.
  // Restart under the mask rather than exposing that new query's old cached value.
  const current = qc.getQueryCache().findAll({ ...filters, type: 'active' });
  return current.every((query) => queries.includes(query));
}

/** Dirty hints are merged into a single bounded invalidation burst. */
export class DomainBatch {
  private domains = new Set<Domain>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private flushDomains: (domains: Domain[]) => void, private delay = 150) {}
  add(domains: Iterable<Domain>): void {
    for (const domain of domains) this.domains.add(domain);
    if (this.domains.size && this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const domains = [...this.domains];
    this.domains.clear();
    if (domains.length) this.flushDomains(domains);
  }
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.domains.clear();
  }
}
