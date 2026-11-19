import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import type { CheckinResult, CheckinStatus, LedgerEntry, Quest, WalletView } from '../../lib/types';

export const questsApi = {
  today: () => apiRequest<Quest[]>('/quests/today'),
  claim: (key: string) => apiRequest<Quest>(`/quests/${key}/claim`, { method: 'POST' }),
  checkinStatus: () => apiRequest<CheckinStatus>('/checkin'),
  checkin: () => apiRequest<CheckinResult>('/checkin', { method: 'POST' }),
};

export const walletApi = {
  get: () => apiRequest<WalletView>('/wallet'),
  ledger: (type?: 'coin' | 'exp') => apiRequest<LedgerEntry[]>(`/ledger${type ? `?type=${type}` : ''}`),
  ledgerPage: (cursor?: string, type?: 'coin' | 'exp', signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    if (type) query.set('type', type);
    return apiRequest<{ items: LedgerEntry[]; nextCursor: string | null }>(`/ledger/page?${query}`, { signal });
  },
};

export const QUESTS_KEY = ['quests', 'today'] as const;
export const CHECKIN_KEY = ['checkin'] as const;
export const WALLET_KEY = ['wallet'] as const;
export const LEDGER_KEY = ['ledger'] as const;

/** Refresh confirmed rewards in the background; a slow read must not hold a successful action open. */
export function refreshQuestRewards(qc: QueryClient): void {
  for (const queryKey of [CHECKIN_KEY, QUESTS_KEY, WALLET_KEY, LEDGER_KEY]) {
    void qc.invalidateQueries({ queryKey }).catch(() => undefined);
  }
}
