import { OUTING_LIMITS, type OutingAllocation, type OutingExpense, type OutingSettlement } from '../models/FriendOuting.js';
import { Errors } from '../utils/errors.js';

export interface OutingBalance {
  userId: string; paid: number; share: number; sent: number; received: number;
  balance: number; reservedOutgoing: number; reservedIncoming: number;
}
export interface OutingTransfer { fromUserId: string; toUserId: string; amount: number }
export function assertVnd(amount: number, max: number = OUTING_LIMITS.expenseAmount): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > max) throw Errors.badRequest('Số tiền phải là VND nguyên trong giới hạn');
}
export function equalAllocations(amount: number, participantIds: string[]): OutingAllocation[] {
  assertVnd(amount);
  const ids = [...new Set(participantIds)].sort();
  if (!ids.length || ids.length !== participantIds.length) throw Errors.badRequest('Danh sách chia tiền trống hoặc trùng');
  const base = Math.floor(amount / ids.length), remainder = amount % ids.length;
  return ids.map((userId, i) => ({ userId, amount: base + (i < remainder ? 1 : 0) })).filter((a) => a.amount > 0);
}
export function customAllocations(amount: number, allocations: OutingAllocation[]): OutingAllocation[] {
  assertVnd(amount);
  if (!allocations.length || new Set(allocations.map((a) => a.userId)).size !== allocations.length ||
      allocations.some((a) => !Number.isSafeInteger(a.amount) || a.amount < 0 || a.amount > OUTING_LIMITS.expenseAmount) ||
      allocations.reduce((sum, a) => sum + a.amount, 0) !== amount) throw Errors.badRequest('Tổng phần chia phải đúng bằng khoản chi');
  return allocations.filter((a) => a.amount > 0).map((a) => ({ ...a })).sort((a, b) => a.userId.localeCompare(b.userId));
}
/** Confirmed and reserved balances are calculated from the same immutable CAS snapshot. */
export function outingBalances(userIds: string[], expenses: OutingExpense[], settlements: OutingSettlement[]): OutingBalance[] {
  const rows = new Map(userIds.map((userId) => [userId, { userId, paid: 0, share: 0, sent: 0, received: 0, balance: 0, reservedOutgoing: 0, reservedIncoming: 0 }]));
  const row = (id: string) => {
    const value = rows.get(id);
    if (!value) throw new Error('Outing invariant: allocation references non-member');
    return value;
  };
  for (const e of expenses) {
    if (e.status !== 'active') continue;
    row(e.payerId).paid += e.amount;
    for (const a of e.allocations) row(a.userId).share += a.amount;
  }
  for (const s of settlements) {
    if (s.status === 'confirmed') { row(s.fromUserId).sent += s.amount; row(s.toUserId).received += s.amount; }
    if (s.status === 'pending') { row(s.fromUserId).reservedOutgoing += s.amount; row(s.toUserId).reservedIncoming += s.amount; }
  }
  const result = [...rows.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  for (const r of result) r.balance = r.paid - r.share + r.sent - r.received;
  if (result.reduce((sum, r) => sum + r.balance, 0) !== 0) throw new Error('Outing invariant: balances do not sum to zero');
  return result;
}
/** Deterministic netting, not a claim of globally minimal transfer count. Pending reservations are excluded. */
export function suggestTransfers(balances: OutingBalance[]): OutingTransfer[] {
  const debtors = balances.filter((r) => r.balance < 0).map((r) => ({ id: r.userId, amount: Math.max(0, -r.balance - r.reservedOutgoing) })).sort((a, b) => a.id.localeCompare(b.id));
  const creditors = balances.filter((r) => r.balance > 0).map((r) => ({ id: r.userId, amount: Math.max(0, r.balance - r.reservedIncoming) })).sort((a, b) => a.id.localeCompare(b.id));
  const result: OutingTransfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j], amount = Math.min(d.amount, c.amount);
    if (amount > 0) result.push({ fromUserId: d.id, toUserId: c.id, amount });
    d.amount -= amount; c.amount -= amount;
    if (!d.amount) i++;
    if (!c.amount) j++;
  }
  return result;
}
