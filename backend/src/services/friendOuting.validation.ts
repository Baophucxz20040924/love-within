import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OUTING_LIMITS } from '../models/FriendOuting.js';
export const outingObjectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ').transform((v) => v.toLowerCase());
const operation = { operationId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/, 'Mã thao tác không hợp lệ'), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) };
const ids = z.array(outingObjectId).min(1).max(OUTING_LIMITS.participants).refine((v) => new Set(v).size === v.length, 'ID trùng').transform((v) => [...v].sort());
const money = z.number().int().min(1).max(OUTING_LIMITS.expenseAmount);
const title = z.string().trim().min(1).max(160);
const allocation = z.object({ userId: outingObjectId, amount: z.number().int().min(0).max(OUTING_LIMITS.expenseAmount) }).strict();
const expenseFields = { amount: money, splitMode: z.enum(['equal', 'custom']), participantIds: ids.optional(), allocations: z.array(allocation).min(1).max(50).optional() };
function validSplit(value: { splitMode: string; participantIds?: string[]; allocations?: unknown[] }) {
  return value.splitMode === 'equal' ? !!value.participantIds && !value.allocations : !!value.allocations && !value.participantIds;
}
export const outingSchemas = {
  create: z.object({ ...operation, expectedRevision: z.literal(0), title: title.max(100),
    outingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const d = new Date(`${v}T00:00:00.000Z`); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Ngày không hợp lệ'),
    inviteeIds: z.array(outingObjectId).max(49).default([]).refine((v) => new Set(v).size === v.length, 'ID trùng').transform((v) => [...v].sort()), eventId: outingObjectId.optional(),
  }).strict(),
  simple: z.object(operation).strict(),
  invite: z.object({ ...operation, userIds: ids }).strict(),
  expense: z.object({ ...operation, title, ...expenseFields }).strict().refine(validSplit, 'Chọn đúng một cách chia tiền'),
  expenseEdit: z.object({ ...operation, title: title.optional(), ...expenseFields }).strict().refine(validSplit, 'Chọn đúng một cách chia tiền'),
  consent: z.object({ ...operation, financeRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  settlement: z.object({ ...operation, toUserId: outingObjectId, amount: z.number().int().min(1).max(OUTING_LIMITS.totalExpenses) }).strict(),
  list: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(100).optional(), eventId: outingObjectId.optional() }).strict(),
};
export type OutingCreateInput = z.infer<typeof outingSchemas.create>;
export type OutingOperationInput = z.infer<typeof outingSchemas.simple>;
export type OutingExpenseInput = z.infer<typeof outingSchemas.expenseEdit>;
export type OutingMutationKind = 'invite' | 'accept' | 'decline' | 'expense_create' | 'expense_edit' | 'expense_void' | 'close_review' | 'approve' | 'object' | 'settlement_create' | 'settlement_confirm' | 'settlement_reject' | 'settlement_cancel' | 'complete';
export type OutingMutationInput = OutingOperationInput & {
  userIds?: string[]; title?: string; amount?: number; splitMode?: 'equal' | 'custom'; participantIds?: string[];
  allocations?: { userId: string; amount: number }[]; financeRevision?: number; toUserId?: string;
};
/** Normalize ordering; zero custom shares remain part of the original beneficiary selection. */
export function outingPayloadHash(kind: string, input: Record<string, unknown>, targetId?: string): string {
  const payload = { ...input };
  delete payload.operationId; delete payload.expectedRevision;
  if (Array.isArray(payload.allocations)) payload.allocations = (payload.allocations as {userId: string; amount: number}[])
    .slice().sort((a, b) => a.userId.localeCompare(b.userId));
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(normalize({ kind, targetId, payload }))).digest('hex');
}
