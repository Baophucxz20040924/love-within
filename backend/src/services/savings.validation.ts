import { z } from 'zod';
import { isRealDate } from '../utils/date.js';

export const savingsObjectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
export const savingsDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'Ngày không có thật');
const targetVnd = z.number().int().min(100_000).max(10_000_000_000);
export const savingsCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  emoji: z.string().trim().min(1).max(16).regex(/^\S+$/u),
  targetVnd,
  dueOn: savingsDay.nullable().default(null),
});
export const savingsUpdateSchema = z.object({
  targetVnd: targetVnd.optional(),
  dueOn: savingsDay.nullable().optional(),
  close: z.literal(true).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), 'Không có gì để cập nhật');
export const savingsUpdatePayloadSchema = z.object({
  ...savingsUpdateSchema.shape,
  goalId: savingsObjectId,
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().optional(),
  emoji: z.string().optional(),
}).refine((v) => v.targetVnd !== undefined || v.dueOn !== undefined || v.close === true, 'Không có gì để cập nhật');
export const savingsEntrySchema = z.object({
  amountVnd: z.number().int().min(-10_000_000_000).max(10_000_000_000).refine((v) => v !== 0, 'Số tiền phải khác 0'),
  occurredOn: savingsDay,
  note: z.string().trim().max(200).default(''),
  // Optional for legacy clients; modern manual writes retain this UUID on retry.
  operationId: z.string().uuid().optional(),
}).refine((v) => v.amountVnd > 0 || v.note.length > 0, { message: 'Rút tiền cần có ghi chú', path: ['note'] });
export const savingsListSchema = z.object({
  cursor: z.string().refine((value) => {
    const [date, id, extra] = value.split('_');
    return !extra && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date ?? '') &&
      Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date && savingsObjectId.safeParse(id).success;
  }, 'Con trỏ không hợp lệ').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['all', 'open', 'active', 'reached', 'closed']).default('all'),
  q: z.string().trim().max(120).optional(),
});
export type SavingsListInput = z.infer<typeof savingsListSchema>;
export type SavingsCreateInput = z.infer<typeof savingsCreateSchema>;
export type SavingsUpdateInput = z.infer<typeof savingsUpdateSchema>;
export type SavingsEntryInput = z.infer<typeof savingsEntrySchema>;
