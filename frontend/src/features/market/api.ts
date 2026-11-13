import { apiRequest } from '../../lib/apiClient';
import type { MarketItem, MarketUnread, Redemption } from '../../lib/types';

export interface MarketItemInput {
  title: string;
  description?: string;
  emoji?: string;
  priceCoin: number;
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
  request: (itemId: string) =>
    apiRequest<{ redemption: Redemption; balance: number }>(`/market/items/${itemId}/redeem`, { method: 'POST' }),
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
