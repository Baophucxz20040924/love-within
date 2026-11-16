import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Couple, type CoupleDoc } from '../models/Couple.js';
import { SavingsGoal, type SavingsGoalDoc, type SavingsStatus } from '../models/SavingsGoal.js';
import { SavingsEntry, type SavingsEntryDoc } from '../models/SavingsEntry.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { BankConnection } from '../models/BankConnection.js';
import { User } from '../models/User.js';
import type { ProposalDoc } from '../models/Proposal.js';
import { savingsRepository, type SavingsTotals } from '../repositories/savings.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { addDays, getLocalDate } from '../utils/date.js';
import { notificationService } from './notification.service.js';
import { withSavingsWrite, type SavingsWriteContext } from './savingsWrite.service.js';
import { savingsCreateSchema, savingsEntrySchema, savingsListSchema, savingsUpdatePayloadSchema, type SavingsEntryInput, type SavingsListInput } from './savings.validation.js';

export interface SavingsGoalView {
  id: string; title: string; emoji: string; targetVnd: number; dueOn: string | null;
  status: SavingsStatus; reachedAt: string | null; createdBy: string; createdAt: string; updatedAt: string;
  pinned: boolean; totalVnd: number; contributions: { userId: string; amountVnd: number }[];
  forecastOn: string | null; version: number;
}
export interface SavingsEntryView {
  id: string; goalId: string; userId: string; amountVnd: number; occurredOn: string; note: string;
  source: 'manual' | 'bank'; createdAt: string; isMine: boolean;
}
export type PulseSavings = Pick<SavingsGoalView, 'id' | 'title' | 'emoji' | 'totalVnd' | 'targetVnd' | 'status' | 'reachedAt'>;
const emptyTotals = (): SavingsTotals => ({ totalVnd: 0, recentVnd: 0, contributions: [] });
const todayOf = (c: CoupleDoc) => getLocalDate(new Date(), c.timezone);
const closed = () => new AppError(409, 'SAVINGS_CLOSED', 'Quỹ đã đóng, chỉ có thể xem lịch sử.');
const stale = () => new AppError(409, 'SAVINGS_STALE_PROPOSAL', 'Quỹ đã thay đổi. Hãy từ chối đề xuất cũ và gửi đề xuất mới.');
const duplicate = (err: unknown) => !!err && typeof err === 'object' && 'code' in err && err.code === 11000;

async function requireGoal(couple: CoupleDoc, id: string): Promise<SavingsGoalDoc> {
  const goal = await savingsRepository.goal(couple._id, id);
  if (!goal) throw Errors.notFound('Quỹ không tồn tại');
  return goal;
}
async function totalsOf(couple: CoupleDoc, goal: SavingsGoalDoc): Promise<SavingsTotals> {
  const today = todayOf(couple);
  return (await savingsRepository.totals(couple._id, [goal._id], addDays(today, -29), today)).get(goal.id) ?? emptyTotals();
}
function goalView(couple: CoupleDoc, goal: SavingsGoalDoc, totals: SavingsTotals): SavingsGoalView {
  // Reads remain truthful even if a worker crashed after writing an entry and before reconciliation.
  const status = goal.status === 'closed' ? 'closed' : totals.totalVnd >= goal.targetVnd ? 'reached' : 'active';
  const days = totals.recentVnd > 0 ? Math.ceil((goal.targetVnd - totals.totalVnd) * 30 / totals.recentVnd) : 0;
  let forecastOn: string | null = null;
  if (status === 'active' && days > 0) {
    // Do not overflow Date or emit an unusable five-digit year for extremely small net contributions.
    const forecast = Date.parse(`${todayOf(couple)}T00:00:00Z`) + days * 86_400_000;
    if (forecast <= Date.parse('9999-12-31T00:00:00Z')) forecastOn = new Date(forecast).toISOString().slice(0, 10);
  }
  return {
    id: goal.id, title: goal.title, emoji: goal.emoji, targetVnd: goal.targetVnd, dueOn: goal.dueOn,
    status, reachedAt: goal.reachedAt?.toISOString() ?? null, createdBy: goal.createdBy.toString(),
    createdAt: goal.createdAt.toISOString(), updatedAt: goal.updatedAt.toISOString(),
    pinned: status !== 'closed' && (couple.pinnedSavingsGoalId?.equals(goal._id) ?? false), totalVnd: totals.totalVnd,
    contributions: couple.memberIds.map((id) => ({ userId: id.toString(), amountVnd: totals.contributions.find((r) => r.userId === id.toString())?.amountVnd ?? 0 })),
    forecastOn, version: goal.version,
  };
}
function entryView(entry: SavingsEntryDoc, userId: string): SavingsEntryView {
  return { id: entry.id, goalId: entry.goalId.toString(), userId: entry.userId.toString(), amountVnd: entry.amountVnd,
    occurredOn: entry.occurredOn, note: entry.note, source: entry.source, createdAt: entry.createdAt.toISOString(), isMine: entry.userId.toString() === userId };
}

/** Must only run under the couple write token, or offline with every API worker stopped. */
export async function reconcileSavingsGoal(ctx: SavingsWriteContext, goal: SavingsGoalDoc, notify = true): Promise<SavingsGoalView> {
  const totals = await totalsOf(ctx.couple, goal);
  if (goal.status === 'closed' && ctx.couple.pinnedSavingsGoalId?.equals(goal._id)) {
    await Couple.updateOne({ _id: ctx.couple._id, savingsWriteToken: ctx.couple.savingsWriteToken,
      pinnedSavingsGoalId: goal._id }, { $set: { pinnedSavingsGoalId: null } }).exec();
    ctx.dirty.add('savings');
    ctx.couple.pinnedSavingsGoalId = null;
  }
  if (goal.status !== 'closed') {
    const reached = totals.totalVnd >= goal.targetVnd;
    if (reached && !goal.reachedAt) {
      const claimed = await SavingsGoal.findOneAndUpdate({ _id: goal._id, coupleId: ctx.couple._id, reachedAt: null,
        status: { $ne: 'closed' }, version: goal.version }, { $set: { reachedAt: new Date(), status: 'reached' } }, { new: true }).exec();
      if (claimed) {
        ctx.dirty.add('savings');
        goal = claimed;
        if (notify) ctx.afterRelease.push(async () => {
          await Promise.all(ctx.couple.memberIds.map((to) => notificationService.emit({
            space: 'couple', coupleId: ctx.couple._id, to, type: 'savings_reached', actorId: null, entityId: goal._id,
            eventKey: String(goal._id), target: { kind: 'savings', id: String(goal._id) },
            push: { body: `Quỹ “${goal.title}” đã đạt mục tiêu!`, url: `/savings/${goal.id}`, tag: `savings:${goal.id}` },
          })));
        });
      }
    } else if (goal.status !== (reached ? 'reached' : 'active')) {
      const changed = await SavingsGoal.findOneAndUpdate({ _id: goal._id, coupleId: ctx.couple._id, version: goal.version, status: { $ne: 'closed' } },
        { $set: { status: reached ? 'reached' : 'active' } }, { new: true }).exec();
      if (changed) { ctx.dirty.add('savings'); goal = changed; }
    }
  }
  return goalView(ctx.couple, goal, totals);
}

/** Durable marker lookup is used BEFORE reject, and on every approve retry. */
export async function savingsEffectExists(couple: CoupleDoc, proposal: ProposalDoc): Promise<boolean> {
  const id = proposal.kind === 'savings_goal' ? proposal._id.toString() : String(proposal.payload.goalId);
  return !!await SavingsGoal.exists({ _id: id, coupleId: couple._id, appliedProposalIds: proposal._id });
}

export async function prepareSavingsProposal(couple: CoupleDoc, kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (kind === 'savings_goal') return savingsCreateSchema.parse(payload);
  const input = savingsUpdatePayloadSchema.parse(payload);
  const goal = await requireGoal(couple, input.goalId);
  if (goal.status === 'closed') throw closed();
  // Discard any client-supplied title/version; these are trusted server snapshots.
  return { goalId: goal.id, title: goal.title, emoji: goal.emoji, expectedVersion: goal.version,
    ...(input.targetVnd !== undefined ? { targetVnd: input.targetVnd } : {}),
    ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}), ...(input.close ? { close: true } : {}) };
}

export async function applySavingsProposal(ctx: SavingsWriteContext, payload: Record<string, unknown>, proposalId: Types.ObjectId, createdBy: Types.ObjectId, kind: string): Promise<void> {
  if (!ctx.couple.memberIds.some((m) => m.equals(createdBy))) throw Errors.forbidden('Người đề xuất không thuộc couple');
  if (kind === 'savings_goal') {
    let goal = await savingsRepository.goal(ctx.couple._id, proposalId);
    if (!goal) {
      const input = savingsCreateSchema.parse(payload);
      goal = await SavingsGoal.create({ ...input, _id: proposalId, coupleId: ctx.couple._id, createdBy, appliedProposalIds: [proposalId] });
      ctx.dirty.add('savings');
    } else if (!goal.appliedProposalIds.some((id) => id.equals(proposalId))) throw stale();
    await reconcileSavingsGoal(ctx, goal);
    return;
  }
  const input = savingsUpdatePayloadSchema.parse(payload);
  let goal = await requireGoal(ctx.couple, input.goalId);
  if (goal.appliedProposalIds.some((id) => id.equals(proposalId))) {
    await reconcileSavingsGoal(ctx, goal);
    return;
  }
  if (goal.status === 'closed' || input.expectedVersion !== goal.version) throw stale();
  const changes: Record<string, unknown> = {};
  if (input.targetVnd !== undefined) changes.targetVnd = input.targetVnd;
  if (input.dueOn !== undefined) changes.dueOn = input.dueOn;
  if (input.close) changes.status = 'closed';
  const changed = await SavingsGoal.findOneAndUpdate({ _id: goal._id, coupleId: ctx.couple._id,
    version: input.expectedVersion, status: { $ne: 'closed' }, appliedProposalIds: { $ne: proposalId } },
  { $set: changes, $inc: { version: 1 }, $addToSet: { appliedProposalIds: proposalId } }, { new: true }).exec();
  if (!changed) throw stale();
  ctx.dirty.add('savings');
  goal = changed;
  await reconcileSavingsGoal(ctx, goal);
}

async function addEntry(ctx: SavingsWriteContext, userId: string, goal: SavingsGoalDoc, input: SavingsEntryInput,
  bank?: { id: Types.ObjectId; fingerprint: string }): Promise<{ entry: SavingsEntryView; goal: SavingsGoalView }> {
  const operationKeyHash = !bank && input.operationId
    ? createHash('sha256').update(JSON.stringify([ctx.couple._id.toString(), userId, input.operationId.toLowerCase()])).digest('hex') : null;
  const operationPayloadHash = operationKeyHash
    ? createHash('sha256').update(JSON.stringify([goal.id, input.amountVnd, input.occurredOn, input.note])).digest('hex') : null;
  // The token is held before looking up a durable key. Never skip reconciliation on replay,
  // and never restore a soft-deleted contribution or send another milestone notification.
  if (operationKeyHash) {
    const existing = await SavingsEntry.findOne({ coupleId: ctx.couple._id, userId, operationKeyHash }).exec();
    if (existing) {
      if (existing.operationPayloadHash !== operationPayloadHash) {
        throw new AppError(409, 'SAVINGS_OPERATION_CONFLICT', 'Mã lần ghi đã dùng cho nội dung khác. Hãy kiểm tra lịch sử quỹ.');
      }
      return { entry: entryView(existing, userId), goal: await reconcileSavingsGoal(ctx, goal, false) };
    }
  }
  if (goal.status === 'closed') throw closed();
  if (input.occurredOn > todayOf(ctx.couple)) throw Errors.badRequest('Ngày góp không được ở tương lai');
  const before = await totalsOf(ctx.couple, goal);
  if (!Number.isSafeInteger(before.totalVnd + input.amountVnd) || !Number.isSafeInteger((before.contributions.find((r) => r.userId === userId)?.amountVnd ?? 0) + input.amountVnd)) {
    throw Errors.badRequest('Tổng tiền vượt giới hạn an toàn');
  }
  let entry: SavingsEntryDoc;
  try {
    entry = await SavingsEntry.create({ amountVnd: input.amountVnd, occurredOn: input.occurredOn, note: input.note,
      coupleId: ctx.couple._id, goalId: goal._id, userId, operationKeyHash, operationPayloadHash,
      source: bank ? 'bank' : 'manual', bankTxnId: bank?.id ?? null, bankFingerprint: bank?.fingerprint ?? null });
  } catch (err) {
    if (duplicate(err) && bank) throw new AppError(409, 'SAVINGS_TRANSACTION_USED', 'Giao dịch này đã được ghi vào quỹ.');
    throw err;
  }
  ctx.dirty.add('savings');
  return { entry: entryView(entry, userId), goal: await reconcileSavingsGoal(ctx, goal) };
}

export const savingsService = {
  async list(couple: CoupleDoc, query: Partial<SavingsListInput> = {}): Promise<{ items: SavingsGoalView[]; nextCursor: string | null }> {
    const input = savingsListSchema.parse(query);
    const today = todayOf(couple);
    const from = addDays(today, -29);
    const exact = input.status === 'active' || input.status === 'reached';
    const rows = await savingsRepository.list(couple._id, input, exact ? { from, today } : undefined);
    const goals = rows.slice(0, input.limit);
    const totals = exact ? null : await savingsRepository.totals(couple._id, goals.map((g) => g._id), from, today);
    const last = goals.at(-1);
    return { items: goals.map((g) => goalView(couple, g, exact ? g.selectedTotals! : totals!.get(g.id) ?? emptyTotals())),
      nextCursor: rows.length > input.limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
  },
  async detail(couple: CoupleDoc, userId: string, id: string, cursor?: string, limit = 20) {
    const goal = await requireGoal(couple, id);
    const filter: Record<string, unknown> = { coupleId: couple._id, goalId: goal._id, deletedAt: null };
    if (cursor) {
      const [day, entryId] = cursor.split('_');
      filter.$or = [{ occurredOn: { $lt: day } }, { occurredOn: day, _id: { $lt: new Types.ObjectId(entryId) } }];
    }
    const rows = await SavingsEntry.find(filter).sort({ occurredOn: -1, _id: -1 }).limit(limit + 1).exec();
    const entries = rows.slice(0, limit);
    const last = entries.at(-1);
    return { goal: goalView(couple, goal, await totalsOf(couple, goal)), entries: entries.map((e) => entryView(e, userId)),
      nextCursor: rows.length > limit && last ? `${last.occurredOn}_${last.id}` : null };
  },
  add(couple: CoupleDoc, userId: string, id: string, raw: SavingsEntryInput) {
    const input = savingsEntrySchema.parse(raw);
    return withSavingsWrite(couple, userId, async (ctx) => addEntry(ctx, userId, await requireGoal(ctx.couple, id), input));
  },
  remove(couple: CoupleDoc, userId: string, id: string, entryId: string) {
    return withSavingsWrite(couple, userId, async (ctx) => {
      const goal = await requireGoal(ctx.couple, id);
      if (goal.status === 'closed') throw closed();
      const entry = await SavingsEntry.findOne({ _id: entryId, coupleId: ctx.couple._id, goalId: goal._id }).exec();
      if (!entry) throw Errors.notFound('Khoản góp không tồn tại');
      if (entry.userId.toString() !== userId) throw Errors.forbidden('Chỉ người ghi được xóa khoản góp');
      if (!entry.deletedAt) {
        const totals = await totalsOf(ctx.couple, goal);
        if (!Number.isSafeInteger(totals.totalVnd - entry.amountVnd) ||
            !Number.isSafeInteger((totals.contributions.find((r) => r.userId === userId)?.amountVnd ?? 0) - entry.amountVnd)) {
          throw Errors.badRequest('Tổng tiền vượt giới hạn an toàn');
        }
        await SavingsEntry.updateOne({ _id: entry._id, coupleId: ctx.couple._id, goalId: goal._id, deletedAt: null }, { $set: { deletedAt: new Date() } }).exec();
        ctx.dirty.add('savings');
      }
      return { ok: true, goal: await reconcileSavingsGoal(ctx, goal) };
    });
  },
  pin(couple: CoupleDoc, userId: string, goalId: string | null) {
    return withSavingsWrite(couple, userId, async (ctx) => {
      if (goalId && (await requireGoal(ctx.couple, goalId)).status === 'closed') throw closed();
      await Couple.updateOne({ _id: ctx.couple._id, savingsWriteToken: ctx.couple.savingsWriteToken }, { $set: { pinnedSavingsGoalId: goalId } }).exec();
      ctx.dirty.add('savings');
      return { goalId };
    });
  },
  attach(couple: CoupleDoc, userId: string, transactionId: string, goalId: string) {
    return withSavingsWrite(couple, userId, async (ctx) => {
      const goal = await requireGoal(ctx.couple, goalId);
      const txn = await BankTransaction.findOne({ _id: transactionId, userId }).select('amount localDate direction providerTxnId').exec();
      if (!txn) throw Errors.notFound('Giao dịch không tồn tại');
      if (txn.direction !== 'out') throw Errors.badRequest('Chỉ gắn được giao dịch tiền ra');
      // Only copied amount/date are shared; bank notes/reference never cross the privacy boundary.
      const parsed = savingsEntrySchema.safeParse({ amountVnd: txn.amount, occurredOn: txn.localDate, note: '' });
      if (!parsed.success) throw Errors.badRequest('Giao dịch không phù hợp giới hạn khoản góp');
      const fingerprint = createHash('sha256').update(JSON.stringify([userId, 'thueapibank', txn.providerTxnId])).digest('hex');
      return addEntry(ctx, userId, goal, parsed.data, { id: txn._id, fingerprint });
    });
  },
  async pulse(couple: CoupleDoc): Promise<PulseSavings | null> {
    if (!couple.pinnedSavingsGoalId) return null;
    const goal = await SavingsGoal.findOne({ _id: couple.pinnedSavingsGoalId, coupleId: couple._id })
      .select('title emoji targetVnd status reachedAt').lean().exec();
    if (!goal || goal.status === 'closed') return null;
    const totalVnd = await savingsRepository.balance(couple._id, goal._id);
    return { id: goal._id.toString(), title: goal.title, emoji: goal.emoji, totalVnd, targetVnd: goal.targetVnd,
      status: totalVnd >= goal.targetVnd ? 'reached' : 'active', reachedAt: goal.reachedAt?.toISOString() ?? null };
  },
  async suggestion(userId: string) {
    // Retained/purged or stale bank history must not be advertised as current savings.
    const connection = await BankConnection.findOne({ userId, status: 'active',
      lastSuccessAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }).select('_id').lean().exec();
    if (!connection) return { suggestion: null };
    const user = await User.findById(userId).select('timezone').lean().exec();
    const today = getLocalDate(new Date(), user?.timezone ?? 'Asia/Ho_Chi_Minh');
    const from = `${today.slice(0, 7)}-01`;
    const previousLast = addDays(from, -1);
    const previousFrom = `${previousLast.slice(0, 7)}-01`;
    const day = Math.min(Number(today.slice(8)), Number(previousLast.slice(8)));
    const previousTo = `${previousLast.slice(0, 7)}-${String(day).padStart(2, '0')}`;
    // Date-bounded aggregate, never a capped listRange and never the partner's data.
    const rows = await BankTransaction.aggregate<{ _id: string; count: number; out: number; earliest: string }>([
      { $match: { userId: new Types.ObjectId(userId), $or: [
        { localDate: { $gte: from, $lte: today } }, { localDate: { $gte: previousFrom, $lte: previousTo } },
      ] } },
      { $group: { _id: { $cond: [{ $gte: ['$localDate', from] }, 'current', 'previous'] },
        count: { $sum: 1 }, earliest: { $min: '$localDate' },
        out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } } } },
    ]).exec();
    const current = rows.find((r) => r._id === 'current');
    const previous = rows.find((r) => r._id === 'previous');
    // Conservative coverage: both periods must contain synced data from their first day.
    // This deliberately hides suggestions when history is incomplete, rather than calling missing spend savings.
    if (!current || !previous || current.earliest !== from || previous.earliest !== previousFrom || previous.out <= current.out) return { suggestion: null };
    return { suggestion: { amountVnd: previous.out - current.out, currentOutVnd: current.out, previousOutVnd: previous.out,
      from, to: today, previousFrom, previousTo,
      message: 'Tháng này bạn chi ít hơn cùng kỳ tháng trước, theo giao dịch đã đồng bộ. Bạn có muốn góp vào quỹ?' } };
  },
};
