import { Types } from 'mongoose';
import { OUTING_LIMITS, type FriendOutingRecord, type OutingExpense, type OutingParticipant } from '../models/FriendOuting.js';
import { outingCapacityError } from '../repositories/friendOuting.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { assertVnd, customAllocations, equalAllocations, outingBalances } from './friendExpenseMath.js';
import type { OutingMutationInput, OutingMutationKind } from './friendOuting.validation.js';

const conflict = (code: string, message: string) => new AppError(409, code, message);
export const outingRevisionConflict = () => conflict('OUTING_REVISION_CONFLICT', 'Sổ vừa thay đổi. Tải lại và kiểm tra trước khi thử lại');
export const outingOperationConflict = () => conflict('OUTING_OPERATION_CONFLICT', 'Mã thao tác đã được dùng với nội dung khác');
export const outingRestrictedError = () => conflict('OUTING_RESTRICTED', 'Quan hệ trong nhóm đã đổi; chỉ còn đối soát lịch sử và thanh toán');
function editable(doc: FriendOutingRecord): void {
  if (doc.phase !== 'collecting' && doc.phase !== 'review') throw conflict('OUTING_PHASE', 'Sổ đã chốt, không thể sửa chi phí hoặc thành viên');
}
function financeChanged(doc: FriendOutingRecord): void {
  doc.financeRevision++;
  doc.phase = 'collecting';
  for (const p of doc.participants) p.consent = null;
}
function member(doc: FriendOutingRecord, actorId: string): OutingParticipant {
  const p = doc.participants.find((p) => p.userId === actorId);
  if (!p) throw Errors.notFound('Buổi chia tiền không tồn tại');
  return p;
}
function allocationsFor(doc: FriendOutingRecord, input: OutingMutationInput) {
  const ids = input.splitMode === 'equal' ? input.participantIds! : input.allocations!.map((a) => a.userId);
  if (ids.some((id) => !doc.participants.some((p) => p.userId === id && p.status === 'accepted'))) throw Errors.badRequest('Chỉ chia tiền cho thành viên đã nhận lời');
  return input.splitMode === 'equal' ? equalAllocations(input.amount!, ids) : customAllocations(input.amount!, input.allocations!);
}
/** Pure snapshot transition. Invites have already passed live friendship/block checks. */
export function applyOutingMutation(doc: FriendOutingRecord, actorId: string, kind: OutingMutationKind,
  input: OutingMutationInput, restricted: boolean, targetId?: string, invited: OutingParticipant[] = []): { resultId: string; bucket: 'ordinary' | 'reserved' } {
  const me = member(doc, actorId), now = new Date();
  let resultId = doc._id.toString();
  if (kind !== 'accept' && kind !== 'decline' && me.status !== 'accepted') throw Errors.forbidden('Hãy nhận lời trước khi dùng sổ');
  let bucket: 'ordinary' | 'reserved' = kind.startsWith('settlement_') || kind === 'complete' ? 'reserved' : 'ordinary';
  const ordinaryClosed = doc.ordinaryWritesClosed || doc.ordinaryOperations >= OUTING_LIMITS.ordinaryOperations;
  if (ordinaryClosed && (kind === 'approve' || kind === 'close_review')) bucket = 'reserved';
  if (bucket === 'ordinary' && ordinaryClosed) throw outingCapacityError();
  if (bucket === 'reserved' && doc.reservedOperations >= OUTING_LIMITS.reservedOperations) throw outingCapacityError();

  switch (kind) {
    case 'invite': {
      editable(doc);
      if (actorId !== doc.creatorId) throw Errors.forbidden('Chỉ người tạo được mời thêm');
      if (restricted) throw outingRestrictedError();
      if (!invited.length) throw Errors.badRequest('Không có thành viên mới');
      if (doc.participants.length + invited.length > OUTING_LIMITS.participants) throw outingCapacityError();
      doc.participants.push(...invited); doc.editCount++;
      break;
    }
    case 'accept': case 'decline': {
      editable(doc);
      if (me.status !== 'pending') throw conflict('OUTING_MEMBERSHIP', 'Lời mời đã được trả lời');
      if (kind === 'accept' && restricted) throw outingRestrictedError();
      me.status = kind === 'accept' ? 'accepted' : 'declined'; doc.editCount++;
      if (kind === 'accept') financeChanged(doc);
      break;
    }
    case 'expense_create': case 'expense_edit': {
      editable(doc);
      if (restricted && kind === 'expense_create') throw outingRestrictedError();
      const old = kind === 'expense_edit' ? doc.expenses.find((e) => e.id === targetId) : undefined;
      if (kind === 'expense_edit' && !old) throw Errors.notFound('Khoản chi không tồn tại');
      if (old && (old.payerId !== actorId || old.status !== 'active')) throw Errors.forbidden('Chỉ sửa khoản đang có do chính bạn trả');
      const allocations = allocationsFor(doc, input);
      const participantIds = (input.splitMode === 'equal' ? [...input.participantIds!] : input.allocations!.map((a) => a.userId)).sort();
      if (restricted && old) {
        const originalIds = [...(old.participantIds ?? old.allocations.map((a) => a.userId))].sort();
        if (input.title !== undefined || participantIds.length !== originalIds.length || participantIds.some((id, index) => id !== originalIds[index]) ||
            allocations.some((a) => a.amount > (old.allocations.find((o) => o.userId === a.userId)?.amount ?? 0))) throw outingRestrictedError();
      }
      const total = doc.totalExpenses - (old?.amount ?? 0) + input.amount!;
      if (total > OUTING_LIMITS.totalExpenses) throw outingCapacityError();
      if (!old && doc.expenses.length >= OUTING_LIMITS.expenses) throw outingCapacityError();
      const expense: OutingExpense = { id: old?.id ?? new Types.ObjectId().toString(), payerId: actorId,
        title: input.title ?? old!.title, amount: input.amount!, splitMode: input.splitMode!,
        participantIds: restricted && old ? [...(old.participantIds ?? old.allocations.map((a) => a.userId))].sort() : participantIds, allocations,
        status: 'active', createdAt: old?.createdAt ?? now, updatedAt: now };
      if (old) { Object.assign(old, expense); doc.editCount++; } else doc.expenses.push(expense);
      doc.totalExpenses = total; resultId = expense.id; financeChanged(doc);
      break;
    }
    case 'expense_void': {
      editable(doc);
      const expense = doc.expenses.find((e) => e.id === targetId);
      if (!expense) throw Errors.notFound('Khoản chi không tồn tại');
      if (expense.payerId !== actorId) throw Errors.forbidden('Chỉ hủy khoản do chính bạn trả');
      if (expense.status !== 'active') throw conflict('OUTING_EXPENSE_STATE', 'Khoản chi đã hủy');
      expense.status = 'void'; expense.updatedAt = now; doc.totalExpenses -= expense.amount; doc.editCount++;
      resultId = expense.id; financeChanged(doc); break;
    }
    case 'close_review': {
      if (doc.phase !== 'collecting') throw conflict('OUTING_PHASE', 'Sổ không ở giai đoạn ghi chi phí');
      doc.phase = 'review'; break;
    }
    case 'approve': case 'object': {
      if (doc.phase !== 'review') throw conflict('OUTING_PHASE', 'Hãy yêu cầu chốt sổ trước khi ký');
      if (input.financeRevision !== doc.financeRevision) throw conflict('OUTING_FINANCE_REVISION', 'Chi phí hoặc thành viên đã thay đổi; cần kiểm tra lại');
      const status = kind === 'approve' ? 'approved' : 'objected';
      if (me.consent?.status === status && me.consent.financeRevision === doc.financeRevision) throw conflict('OUTING_CONSENT_STATE', 'Bạn đã ghi nhận ý kiến này');
      me.consent = { status, financeRevision: doc.financeRevision };
      if (doc.participants.filter((p) => p.status === 'accepted').every((p) => p.consent?.status === 'approved' && p.consent.financeRevision === doc.financeRevision)) {
        doc.phase = 'settling'; doc.frozenAt = now;
      }
      break;
    }
    case 'settlement_create': {
      if (doc.phase !== 'settling') throw conflict('OUTING_PHASE', 'Chỉ báo chuyển tiền sau khi mọi người đã chốt sổ');
      assertVnd(input.amount!, OUTING_LIMITS.totalExpenses);
      const balances = outingBalances(doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId), doc.expenses, doc.settlements);
      const from = balances.find((b) => b.userId === actorId), to = balances.find((b) => b.userId === input.toUserId);
      const debt = from ? -from.balance - from.reservedOutgoing : 0, credit = to ? to.balance - to.reservedIncoming : 0;
      if (input.toUserId === actorId || input.amount! > debt || input.amount! > credit) throw conflict('OUTING_PAYMENT_CONFLICT', 'Số tiền vượt phần nợ hoặc phần nhận còn trống');
      if (doc.settlements.length >= OUTING_LIMITS.settlements) throw outingCapacityError();
      // Pending transfers may be rejected: exhausting only the unreserved remainder is not full settlement.
      if (doc.settlements.length >= OUTING_LIMITS.settlements - OUTING_LIMITS.finalSettlementSlots &&
          input.amount !== -from!.balance && input.amount !== to!.balance) throw conflict('OUTING_FINAL_SETTLEMENT_SLOTS', 'Các lượt cuối chỉ dùng để trả hết nợ hoặc phần nhận của một bên; hãy xử lý các lời báo chuyển đang chờ trước');
      resultId = new Types.ObjectId().toString();
      doc.settlements.push({ id: resultId, fromUserId: actorId, toUserId: input.toUserId!, amount: input.amount!, status: 'pending', createdAt: now, resolvedAt: null });
      break;
    }
    case 'settlement_confirm': case 'settlement_reject': case 'settlement_cancel': {
      if (doc.phase !== 'settling') throw conflict('OUTING_PHASE', 'Sổ không ở giai đoạn thanh toán');
      const s = doc.settlements.find((s) => s.id === targetId);
      if (!s) throw Errors.notFound('Lời báo chuyển không tồn tại');
      if ((kind === 'settlement_cancel' ? s.fromUserId : s.toUserId) !== actorId) throw Errors.forbidden('Bạn không được xử lý lời báo chuyển này');
      if (s.status !== 'pending') throw conflict('OUTING_PAYMENT_CONFLICT', 'Lời báo chuyển đã được xử lý');
      if (kind === 'settlement_confirm') {
        const rows = outingBalances(doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId), doc.expenses, doc.settlements);
        const from = rows.find((b) => b.userId === s.fromUserId)!, to = rows.find((b) => b.userId === s.toUserId)!;
        if (from.reservedOutgoing < s.amount || to.reservedIncoming < s.amount || -from.balance < from.reservedOutgoing || to.balance < to.reservedIncoming) throw conflict('OUTING_PAYMENT_CONFLICT', 'Phần tiền dự giữ không còn phù hợp');
      }
      s.status = kind === 'settlement_confirm' ? 'confirmed' : kind === 'settlement_reject' ? 'rejected' : 'cancelled';
      s.resolvedAt = now; resultId = s.id; break;
    }
    case 'complete': {
      if (doc.phase !== 'settling') throw conflict('OUTING_PHASE', 'Sổ chưa sẵn sàng hoàn tất');
      const balances = outingBalances(doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId), doc.expenses, doc.settlements);
      if (doc.settlements.some((s) => s.status === 'pending') || balances.some((b) => b.balance !== 0)) throw conflict('OUTING_PAYMENT_CONFLICT', 'Còn số dư hoặc lời báo chuyển đang chờ');
      doc.phase = 'completed'; doc.completedAt = now; break;
    }
  }
  if (bucket === 'ordinary') doc.ordinaryOperations++; else doc.reservedOperations++;
  return { resultId, bucket };
}
