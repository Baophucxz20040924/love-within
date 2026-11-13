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
};

export const QUESTS_KEY = ['quests', 'today'] as const;
export const CHECKIN_KEY = ['checkin'] as const;
export const WALLET_KEY = ['wallet'] as const;
export const LEDGER_KEY = ['ledger'] as const;
