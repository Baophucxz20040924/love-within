import { apiRequest } from '../../../lib/apiClient';
import type { CreateOuting, ExpenseInput, MutationMeta, OutingResult, OutingSummary, OutingView } from './types';
const root = '/friends/outings';
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
const post = <T extends MutationMeta>(id: string, action: string, body: T) => apiRequest<OutingResult>(`${path(id)}/${action}`, { method: 'POST', body });
export const OUTINGS_KEY = ['friends', 'outings'] as const;
export const outingKey = (id: string) => ['friends', 'outing', id] as const;
export const outingsApi = {
  list: (cursor?: string) => apiRequest<{ items: OutingSummary[]; nextCursor: string | null }>(`${root}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  forEvent: (eventId: string) => apiRequest<{ items: OutingSummary[]; nextCursor: string | null }>(`${root}?eventId=${encodeURIComponent(eventId)}&limit=20`),
  get: (id: string) => apiRequest<OutingView>(path(id)),
  create: (body: CreateOuting & MutationMeta) => apiRequest<OutingResult>(root, { method: 'POST', body }),
  membership: (id: string, action: 'accept' | 'decline', meta: MutationMeta) => post(id, `members/${action}`, meta),
  // The legacy endpoint name is retained; new members join immediately without financial consent.
  addMembers: (id: string, userIds: string[], meta: MutationMeta) => post(id, 'members/invite', { ...meta, userIds }),
  expense: (id: string, input: ExpenseInput, meta: MutationMeta, expenseId?: string) => expenseId
    ? apiRequest<OutingResult>(`${path(id)}/expenses/${encodeURIComponent(expenseId)}`, { method: 'PATCH', body: { ...meta, ...input } })
    : post(id, 'expenses', { ...meta, ...input }),
  voidExpense: (id: string, expenseId: string, meta: MutationMeta) => post(id, `expenses/${encodeURIComponent(expenseId)}/void`, meta),
  review: (id: string, meta: MutationMeta) => post(id, 'close-review', meta),
  consent: (id: string, action: 'approve' | 'object', financeRevision: number, meta: MutationMeta) => post(id, action, { ...meta, financeRevision }),
  settlement: (id: string, toUserId: string, amount: number, meta: MutationMeta) => post(id, 'settlements', { ...meta, toUserId, amount }),
  resolve: (id: string, settlementId: string, action: 'confirm' | 'reject' | 'cancel', meta: MutationMeta) => post(id, `settlements/${encodeURIComponent(settlementId)}/${action}`, meta),
  complete: (id: string, meta: MutationMeta) => post(id, 'complete', meta),
};
