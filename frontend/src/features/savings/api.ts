import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import { apiRequest, ApiRequestError } from '../../lib/apiClient';
import type { Proposal, SavingsDetail, SavingsEntry, SavingsEntryInput, SavingsGoal, SavingsGoalInput, SavingsGoalPage, SavingsListInput, SavingsSuggestion, SavingsUpdateInput } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';
import { PROPOSAL_KEY } from '../proposals/api';

const enc = encodeURIComponent;
export const SAVINGS_KEY = ['savings'] as const;
export const SAVINGS_LIST_KEY = ['savings', 'list'] as const;
export const savingsDetailKey = (id: string) => ['savings', 'detail', id] as const;
export const SAVINGS_SUGGESTION_KEY = ['savings', 'suggestion'] as const;
type EntryResult = { entry: SavingsEntry; goal: SavingsGoal };

export const savingsApi = {
  list: (input: SavingsListInput = {}) => {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.q?.trim()) params.set('q', input.q.trim());
    if (input.limit) params.set('limit', String(input.limit));
    if (input.cursor) params.set('cursor', input.cursor);
    return apiRequest<SavingsGoalPage>(`/savings${params.size ? `?${params}` : ''}`);
  },
  detail: (id: string, cursor?: string) => apiRequest<SavingsDetail>(`/savings/${enc(id)}${cursor ? `?cursor=${enc(cursor)}` : ''}`),
  suggest: () => apiRequest<{ suggestion: SavingsSuggestion | null }>('/savings/suggestion'),
  propose: (body: SavingsGoalInput) => apiRequest<Proposal>('/savings/propose', { method: 'POST', body }),
  proposeUpdate: (id: string, body: SavingsUpdateInput) => apiRequest<Proposal>(`/savings/${enc(id)}/propose-update`, { method: 'POST', body }),
  addEntry: (id: string, body: SavingsEntryInput) => apiRequest<EntryResult>(`/savings/${enc(id)}/entries`, { method: 'POST', body }),
  removeEntry: (id: string, entryId: string) => apiRequest<{ ok: true; goal: SavingsGoal }>(`/savings/${enc(id)}/entries/${enc(entryId)}`, { method: 'DELETE' }),
  pin: (goalId: string | null) => apiRequest<{ goalId: string | null }>('/savings/pinned', { method: 'PUT', body: { goalId } }),
  attach: (txnId: string, goalId: string) => apiRequest<EntryResult>(`/finance/transactions/${enc(txnId)}/savings`, { method: 'POST', body: { goalId } }),
};

export function savingsListOptions(input: Omit<SavingsListInput, 'cursor'> = {}) {
  const filters = { status: input.status ?? 'all', q: input.q?.trim() ?? '', limit: input.limit ?? 20 };
  return infiniteQueryOptions({
    queryKey: [...SAVINGS_LIST_KEY, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => savingsApi.list({ ...filters, cursor: pageParam }),
    getNextPageParam: (page: SavingsGoalPage) => page.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** No extra polling: refresh every savings surface and the existing combined Home pulse. */
export async function refreshSavings(qc: QueryClient): Promise<void> {
  await Promise.all([SAVINGS_KEY, PULSE_KEY, PROPOSAL_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export function savingsError(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === 'SAVINGS_BUSY') return 'Quỹ đang xử lý thay đổi khác. Chờ một chút rồi thử lại nhé.';
  return err instanceof Error ? err.message : 'Không lưu được, thử lại nhé.';
}

export function savingsNeedsRetry(p: Proposal): boolean {
  return (p.kind === 'savings_goal' || p.kind === 'savings_goal_update') && p.status === 'pending' &&
    (p.applicationState === 'retryable' || p.approvals.length >= 2);
}
