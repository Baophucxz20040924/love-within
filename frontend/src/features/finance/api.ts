import { ApiRequestError, apiRequest } from '../../lib/apiClient';
import type {
  BankTxn,
  BankTxnPage,
  FinanceConnection,
  FinanceDisconnectResult,
  FinanceLinkResult,
  FinanceSummary,
  FinanceSyncResult,
  FinanceVisibility,
} from '../../lib/types';

/** Whose cash flow a view shows. */
export type FinanceOwner = 'mine' | 'partner';

const base = (owner: FinanceOwner) => (owner === 'partner' ? '/finance/partner' : '/finance');

export const financeApi = {
  connection: () => apiRequest<FinanceConnection>('/finance/connection'),
  link: (token: string, accountLast4: string) =>
    apiRequest<FinanceLinkResult>('/finance/connection', { method: 'POST', body: { token, accountLast4 } }),
  sync: () => apiRequest<FinanceSyncResult>('/finance/connection/sync', { method: 'POST' }),
  disconnect: (purge: boolean) => apiRequest<FinanceDisconnectResult>(`/finance/connection?purge=${purge}`, { method: 'DELETE' }),
  setVisibility: (visibility: FinanceVisibility) =>
    apiRequest<{ visibility: FinanceVisibility }>('/finance/settings', { method: 'PATCH', body: { visibility } }),
  transactions: (owner: FinanceOwner, month: string, cursor?: string) =>
    apiRequest<BankTxnPage>(
      `${base(owner)}/transactions?month=${encodeURIComponent(month)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  summary: (owner: FinanceOwner, month: string) =>
    apiRequest<FinanceSummary>(`${base(owner)}/summary?month=${encodeURIComponent(month)}`),
  setNote: (id: string, note: string) =>
    apiRequest<BankTxn>(`/finance/transactions/${encodeURIComponent(id)}/note`, { method: 'PATCH', body: { note } }),
};

export const FINANCE_KEY = ['finance'] as const;
export const FINANCE_CONNECTION_KEY = ['finance', 'connection'] as const;
export const financeOwnerKey = (owner: FinanceOwner) => ['finance', owner] as const;
export const financeTxnsKey = (owner: FinanceOwner, month: string) => ['finance', owner, 'txns', month] as const;
export const financeSummaryKey = (owner: FinanceOwner, month: string) => ['finance', owner, 'summary', month] as const;

/** 403 FINANCE_PRIVATE / 404 FINANCE_NOT_LINKED are answers, not failures: never retry them. */
export function retryUnlessAnswer(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) return false;
  return failureCount < 1;
}

/** "TOKEN_INVALID: Token không hợp lệ" → "Token không hợp lệ". */
export function lastErrorText(lastError: string | null): string {
  if (!lastError) return '';
  const i = lastError.indexOf(': ');
  return i >= 0 ? lastError.slice(i + 2) : lastError;
}

export const THUEAPIBANK_URL = 'https://thueapibank.vn';
