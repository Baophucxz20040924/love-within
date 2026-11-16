import type { OutingExpense, OutingLedger, OutingPhase } from './types';

export const expenseParticipantIds = (expense: OutingExpense): string[] => expense.participantIds ?? expense.allocations.map(a => a.userId);
export function outingLimits(outing: OutingLedger) {
  const c = outing.capacity;
  const ordinaryClosed = c.editsFrozen || c.ordinaryOperations.used >= c.ordinaryOperations.max;
  const editsClosed = ordinaryClosed || c.edits.used >= c.edits.max;
  const reservedClosed = c.reservedOperations.used >= c.reservedOperations.max;
  return {
    ordinaryClosed, editsClosed, reservedClosed,
    rosterRemaining: Math.max(0, c.participants.max - c.participants.used),
    canCreateExpense: !ordinaryClosed && c.expenses.used < c.expenses.max,
    canSettle: !reservedClosed && c.settlements.used < c.settlements.max,
    canReview: !ordinaryClosed || !reservedClosed,
  };
}
/** Tail slots must clear a confirmed balance, not merely its unreserved remainder. */
export function canReportSettlement(outing: OutingLedger, fromId: string, toId: string, amount: number): boolean {
  const from = outing.balances.find(b => b.userId === fromId), to = outing.balances.find(b => b.userId === toId);
  return outingLimits(outing).canSettle && !!from && !!to && fromId !== toId && Number.isSafeInteger(amount) && amount > 0 &&
    amount <= -from.balance - from.reservedOutgoing && amount <= to.balance - to.reservedIncoming &&
    (!outing.capacity.finalSettlementSlots || amount === -from.balance || amount === to.balance);
}
export const phaseLabel: Record<OutingPhase, string> = { collecting: 'Ghi chi phí', review: 'Chờ đồng ý chốt', settling: 'Thanh toán', completed: 'Hoàn tất' };
export const outingDate = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' });
export const settlementLabel = { pending: 'Đã báo chuyển · Chờ xác nhận', confirmed: 'Người nhận đã xác nhận', rejected: 'Người nhận đã từ chối', cancelled: 'Người gửi đã hủy' };
export const actionLabel: Record<string, string> = { create: 'Tạo buổi chia tiền', invite: 'Thêm thành viên', accept: 'Nhận lời tham gia', decline: 'Từ chối lời mời', expense_create: 'Thêm chi phí', expense_edit: 'Sửa chi phí', expense_void: 'Hủy chi phí', review: 'Đề nghị chốt sổ', approve: 'Đồng ý chốt sổ', object: 'Chưa đồng ý chốt sổ', settlement_create: 'Báo đã chuyển tiền', settlement_confirm: 'Xác nhận đã nhận', settlement_reject: 'Từ chối lời báo chuyển', settlement_cancel: 'Hủy lời báo chuyển', complete: 'Hoàn tất buổi' };
