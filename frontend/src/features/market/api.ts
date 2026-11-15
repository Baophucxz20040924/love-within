import { apiRequest } from '../../lib/apiClient';
import type { MarketItem, MarketUnread, Redemption } from '../../lib/types';

export interface MarketItemInput {
  title: string;
  description?: string;
  emoji?: string;
  priceCoin: number;
}

const pendingRequests = new Map<string, string>();
/** Keep an uncertain request identity across reload; scope prevents account/couple reuse. Contains no balances or tokens. */
export function marketRequestKey(scope: string): string {
  const storageKey = `market-request:${scope}`;
  let key = pendingRequests.get(scope);
  try { key ??= sessionStorage.getItem(storageKey) ?? undefined; } catch { /* storage unavailable */ }
  if (!key) key = crypto.randomUUID();
  pendingRequests.set(scope, key);
  try { sessionStorage.setItem(storageKey, key); } catch { /* in-memory fallback */ }
  return key;
}
export function clearMarketRequestKey(scope: string): void {
  pendingRequests.delete(scope);
  try { sessionStorage.removeItem(`market-request:${scope}`); } catch { /* storage unavailable */ }
}

export function isRecoveredRedemption(status: Redemption['status']): boolean {
  return status !== 'requested';
}

export const marketApi = {
  // Items: every available item in the couple, flagged isMine.
  list: () => apiRequest<MarketItem[]>('/market/items'),
  create: (input: MarketItemInput) => apiRequest<MarketItem>('/market/items', { method: 'POST', body: input }),
  update: (id: string, patch: Partial<MarketItemInput>) =>
    apiRequest<MarketItem>(`/market/items/${id}`, { method: 'PATCH', body: patch }),
  archive: (id: string) => apiRequest<{ ok: true }>(`/market/items/${id}`, { method: 'DELETE' }),

  // Redemption flow.
  /** Ask the partner for one of their rewards; coins are held until they answer. */
  request: (itemId: string, requestKey: string) =>
    apiRequest<{ redemption: Redemption; balance: number }>(`/market/items/${itemId}/redeem`, { method: 'POST', body: { requestKey } }),
  history: () => apiRequest<Redemption[]>('/market/redemptions'),
  pending: () => apiRequest<Redemption[]>('/market/redemptions/pending'),
  accept: (id: string) => apiRequest<Redemption>(`/market/redemptions/${id}/accept`, { method: 'POST' }),
  decline: (id: string, note?: string) =>
    apiRequest<Redemption>(`/market/redemptions/${id}/decline`, { method: 'POST', body: note ? { note } : {} }),
  cancel: (id: string) => apiRequest<Redemption>(`/market/redemptions/${id}/cancel`, { method: 'POST' }),
  fulfill: (id: string) => apiRequest<Redemption>(`/market/redemptions/${id}/fulfill`, { method: 'POST' }),

  // Tab badge.
  unread: () => apiRequest<MarketUnread>('/market/unread-count'),
  seen: () => apiRequest<{ ok: true }>('/market/seen', { method: 'POST' }),
};

export const MARKET_KEY = ['market', 'items'] as const;
export const REDEMPTIONS_KEY = ['market', 'redemptions'] as const;
export const MARKET_PENDING_KEY = ['market', 'pending'] as const;
export const MARKET_UNREAD_KEY = ['market', 'unread'] as const;
