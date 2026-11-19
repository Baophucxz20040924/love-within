import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { realtimeAudience } from './realtimeAudience.service.js';
import { ECONOMY, levelFromExp } from '../config/economy.js';
import { Couple } from '../models/Couple.js';
import { Checkin } from '../models/Checkin.js';
import { QuestProgress } from '../models/Quest.js';
import { BucketItem } from '../models/BucketItem.js';
import { bucketRewardDayRepository } from '../repositories/bucket.repository.js';
import { finishBucketCompletion } from './bucketCompletion.service.js';
import type { LedgerEntryDoc, LedgerReason, LedgerType } from '../models/LedgerEntry.js';
import type { WalletDoc, WalletPending } from '../models/Wallet.js';
import type { OperationPayload, OperationResult, WalletOperationDoc, RewardProvenance } from '../models/WalletOperation.js';
import { dailyRewardService } from './dailyReward.service.js';
import { walletRepository, splitCoin, walletReview } from '../repositories/wallet.repository.js';
import { Errors } from '../utils/errors.js';
import { observeRecovery, recoveryNow } from '../utils/monitor.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../utils/historyCursor.js';

type RecoveryStage = 'whole' | 'checkin' | 'quest' | 'bucket' | 'daily';
type RecoveryCounts = { examined: number; terminal: number; deferred: number; errors: number; saturated: number };
const emptyRecoveryCounts = (): RecoveryCounts => ({ examined: 0, terminal: 0, deferred: 0, errors: 0, saturated: 0 });
// Telemetry is best effort, including the clock, and must never interfere with recovery.
function recoveryStart(): number { try { return recoveryNow(); } catch { return NaN; } }
function recoveryObserve(stage: RecoveryStage, outcome: 'ok' | 'empty' | 'partial' | 'error', start: number, counts: RecoveryCounts): void {
  try { observeRecovery(stage, outcome, recoveryNow() - start, counts); } catch { /* best effort */ }
}
function addRecoveryCounts(total: RecoveryCounts, counts: RecoveryCounts): void {
  total.examined += counts.examined; total.terminal += counts.terminal; total.deferred += counts.deferred;
  total.errors += counts.errors; total.saturated += counts.saturated;
}

export interface ApplyInput {
  coupleId: Types.ObjectId;
  operationId: string;
  actorUserId: string;
  ownerUserId: string;
  delta: number;
  reason: LedgerReason;
  refId?: Types.ObjectId | null;
  provenance?: RewardProvenance;
}
export interface WalletView {
  coinBalance: number;
  ownerUserId: string;
  exp: number;
  level: number;
  levelBaseExp: number;
  nextLevelExp: number | null;
}
export interface LedgerView {
  id: string; type: LedgerType; delta: number; balanceAfter: number; reason: LedgerReason;
  refId: string | null; actorUserId: string; ownerUserId: string | null;
  scope: 'personal' | 'shared_exp' | 'legacy_shared'; createdAt: string;
  provenance?: RewardProvenance;
}
function toLedgerView(e: LedgerEntryDoc): LedgerView {
  return { id: e._id.toString(), type: e.type, delta: e.delta, balanceAfter: e.balanceAfter,
    reason: e.reason, refId: e.refId?.toString() ?? null, actorUserId: e.actorUserId.toString(),
    ownerUserId: e.ownerUserId?.toString() ?? null,
    ...(e.provenance ? { provenance: e.provenance } : {}),
    scope: e.type === 'exp' ? 'shared_exp' : e.ownerUserId ? 'personal' : 'legacy_shared', createdAt: e.createdAt.toISOString() };
}
function fingerprint(payload: OperationPayload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function assertPayload(op: WalletOperationDoc, coupleId: Types.ObjectId, expected: string) {
  if (String(op.coupleId) !== String(coupleId) || op.fingerprint !== expected) throw Errors.conflict('Mã giao dịch đã dùng cho nội dung khác');
}
function resultOf(op: WalletOperationDoc): OperationResult {
  if (!op.result) throw walletReview();
  if (op.status === 'rejected') {
    const owner = Object.keys(op.payload.allocations)[0];
    const balance = op.result.balances[owner];
    const missing = -op.payload.allocations[owner] - balance;
    throw Errors.unprocessable(`Ví Xu của bạn không đủ (thiếu ${missing} Xu)`, { missing, balance });
  }
  return op.result;
}

/** EXP and its single receipt are atomic on Couple. Revision plus terminal recheck fence stale workers. */
async function applyExp(op: WalletOperationDoc): Promise<Pick<OperationResult, 'exp' | 'level' | 'leveledUp'>> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const terminal = await walletRepository.findOperation(op._id);
    if (terminal?.status === 'committed') return terminal.result!;
    const couple = await Couple.findById(op.coupleId).exec();
    if (!couple) throw walletReview();
    if (couple.expReceipt?.operationId === op._id) return couple.expReceipt;
    // Do not clear/steal a foreign receipt. The wallet journal serializes all reward operations.
    if (couple.expReceipt) {
      const owner = await walletRepository.findOperation(couple.expReceipt.operationId);
      if (owner?.status === 'committed') {
        await Couple.updateOne({ _id: op.coupleId, 'expReceipt.operationId': owner._id }, {
          $set: { expReceipt: null }, $inc: { expRevision: 1 },
        }).exec();
        continue;
      }
      throw walletReview();
    }
    const afterSnapshot = await walletRepository.findOperation(op._id);
    if (afterSnapshot?.status === 'committed') return afterSnapshot.result!;
    const exp = couple.exp + op.payload.exp;
    if (!Number.isSafeInteger(exp) || exp < 0) throw walletReview();
    const level = levelFromExp(exp);
    const receipt = { operationId: op._id, exp, level, leveledUp: level > levelFromExp(couple.exp) };
    const revision = couple.expRevision ?? 0;
    const updated = await Couple.findOneAndUpdate({ _id: op.coupleId, expReceipt: null,
      $expr: { $eq: [{ $ifNull: ['$expRevision', 0] }, revision] },
    }, { $inc: { exp: op.payload.exp, expRevision: 1 }, $set: { level, expReceipt: receipt } }, { new: true }).exec();
    if (updated) return receipt;
  }
  throw walletReview();
}

/** Recover only the exact durable operation. Never infer application from a timeout or a separate done flag. */
async function finish(coupleId: Types.ObjectId, pending: WalletPending): Promise<void> {
  const op = await walletRepository.findOperation(pending.operationId);
  if (!op || String(op.coupleId) !== String(coupleId)) throw walletReview();
  if (op.status === 'pending') {
    const result: OperationResult = { balances: pending.balances };
    if (!pending.rejected) {
      if (op.payload.exp > 0) Object.assign(result, await applyExp(op));
      for (const [owner, delta] of Object.entries(op.payload.allocations)) {
        if (delta === 0) continue;
        await walletRepository.appendLedger({ operationKey: `${op._id}:coin:${owner}`, coupleId, type: 'coin', delta,
          balanceAfter: pending.balances[owner], reason: op.payload.reason,
          refId: op.payload.refId ? new Types.ObjectId(op.payload.refId) : null,
          actorUserId: new Types.ObjectId(op.payload.actorUserId), ownerUserId: new Types.ObjectId(owner),
          ...(op.payload.provenance ? { provenance: op.payload.provenance } : {}) });
      }
      if (op.payload.exp > 0) await walletRepository.appendLedger({ operationKey: `${op._id}:exp`, coupleId, type: 'exp',
        delta: op.payload.exp, balanceAfter: result.exp!, reason: op.payload.reason,
        refId: op.payload.refId ? new Types.ObjectId(op.payload.refId) : null,
        actorUserId: new Types.ObjectId(op.payload.actorUserId), ownerUserId: null,
        ...(op.payload.provenance ? { provenance: op.payload.provenance } : {}) });
    }
    // Durable terminal tombstone MUST precede clearing either bounded journal.
    await walletRepository.commit(op._id, result, pending.rejected);
  }
  await Couple.updateOne({ _id: coupleId, 'expReceipt.operationId': op._id }, {
    $set: { expReceipt: null }, $inc: { expRevision: 1 },
  }).exec();
  await walletRepository.clear(coupleId, pending);
}

async function execute(coupleId: Types.ObjectId, operationId: string, payload: OperationPayload): Promise<OperationResult> {
  if (!operationId || operationId.length > 180 || !Number.isSafeInteger(payload.exp) || payload.exp < 0) throw Errors.badRequest('Giao dịch không hợp lệ');
  const id = `${coupleId}:${operationId}`;
  const hash = fingerprint(payload);
  // Terminal lookup comes BEFORE any wallet snapshot. Repeat after snapshot to close the lookup/clear race.
  let op = await walletRepository.findOperation(id);
  if (op) {
    assertPayload(op, coupleId, hash);
    if (op.status !== 'pending') return resultOf(op);
  }
  op = await walletRepository.ensureOperation(id, coupleId, payload, hash);
  assertPayload(op, coupleId, hash);
  for (let attempt = 0; attempt < 24; attempt++) {
    op = (await walletRepository.findOperation(id))!;
    if (op.status !== 'pending') return resultOf(op);
    const wallet = await walletRepository.getOrCreate(coupleId);
    if (!wallet.memberIds.includes(payload.actorUserId) || Object.keys(payload.allocations).some((owner) => !wallet.memberIds.includes(owner))) throw Errors.forbidden();
    if (wallet.pending) { await finish(coupleId, wallet.pending); continue; }
    op = (await walletRepository.findOperation(id))!;
    if (op.status !== 'pending') return resultOf(op);
    const balances = { ...wallet.balances };
    let rejected = false;
    for (const [owner, delta] of Object.entries(payload.allocations)) {
      if (!Number.isSafeInteger(delta)) throw Errors.badRequest('Số Xu không hợp lệ');
      const value = balances[owner] + delta;
      if (!Number.isSafeInteger(value)) throw walletReview();
      if (value < 0) rejected = true;
      balances[owner] = value;
    }
    const finalBalances = rejected ? { ...wallet.balances } : balances;
    const pending = { operationId: id, revision: wallet.revision + 1, balances: finalBalances, rejected };
    const applied = await walletRepository.apply(coupleId, wallet.revision, finalBalances, pending);
    if (!applied) continue;
    await finish(coupleId, pending);
  }
  throw walletReview();
}

async function ownWallet(coupleId: Types.ObjectId, userId: string): Promise<WalletDoc> {
  let wallet = await walletRepository.getOrCreate(coupleId);
  if (!wallet.memberIds.includes(userId)) throw Errors.forbidden();
  if (wallet.pending) {
    await finish(coupleId, wallet.pending);
    wallet = await walletRepository.getOrCreate(coupleId);
  }
  return wallet;
}
export const walletService = {
  /** Bounded online recovery also covers a crash before the first wallet write, including older days. */
  async recoverRewards(coupleId: Types.ObjectId): Promise<void> {
    const started = recoveryStart();
    const total = emptyRecoveryCounts();
    let wholeFailed = false;
    try {
      const filter = { coupleId, rewardIntent: { $ne: null }, rewardCompletedAt: null };
      const sources = [
        { rows: () => Checkin.find(filter).sort({ _id: 1 }).limit(20).exec(), complete: (id: Types.ObjectId) => Checkin.updateOne({ _id: id, rewardCompletedAt: null }, { $set: { rewardCompletedAt: new Date() } }).exec(), reason: 'checkin' as const },
        { rows: () => QuestProgress.find(filter).sort({ _id: 1 }).limit(20).exec(), complete: (id: Types.ObjectId) => QuestProgress.updateOne({ _id: id, rewardCompletedAt: null }, { $set: { rewardCompletedAt: new Date() } }).exec(), reason: 'quest' as const },
        { rows: () => BucketItem.find({ ...filter, rewardDenied: { $ne: true } }).sort({ _id: 1 }).limit(20).exec(), complete: (id: Types.ObjectId) => BucketItem.updateOne({ _id: id, rewardCompletedAt: null }, { $set: { rewardCompletedAt: new Date() } }).exec(), reason: 'bucket_list' as const },
      ];
      for (const source of sources) {
        const { reason } = source;
        const stage = reason === 'bucket_list' ? 'bucket' : reason;
        const stageStarted = recoveryStart();
        const counts = emptyRecoveryCounts();
        let failed = false;
        try {
          const rows = await source.rows();
          if (rows.length === 20) counts.saturated++;
          for (const row of rows) {
            counts.examined++;
            const intent = row.rewardIntent;
            if (!intent) { counts.deferred++; continue; }
            if (reason === 'bucket_list') {
              const couple = await Couple.findById(coupleId).exec();
              if (!couple) throw walletReview();
              try { if (!(await finishBucketCompletion(couple, row as import('../models/BucketItem.js').BucketItemDoc))) { counts.deferred++; continue; } }
              catch { counts.errors++; counts.deferred++; continue; } // An unavailable story cannot block unrelated personal-wallet reads.
            }
            if (reason === 'bucket_list' && !(await bucketRewardDayRepository.take(coupleId, intent.localDate!, ECONOMY.bucket.maxRewardsPerDay, intent.operationId))) {
              const denied = await BucketItem.updateOne({ _id: row._id, rewardCompletedAt: null }, { $set: { rewardDenied: true } }).exec();
              if (denied?.modifiedCount > 0) counts.terminal++;
              continue;
            }
            await walletService.reward({ ...intent, coupleId, reason, refId: row._id });
            const completed = await source.complete(row._id);
            if (completed?.modifiedCount > 0) counts.terminal++;
          }
        } catch (error) {
          failed = true;
          counts.errors++;
          throw error;
        } finally {
          addRecoveryCounts(total, counts);
          recoveryObserve(stage, failed ? 'error' : counts.errors || counts.deferred ? 'partial' : counts.examined ? 'ok' : 'empty', stageStarted, counts);
        }
      }
      const stageStarted = recoveryStart();
      const counts = emptyRecoveryCounts();
      let failed = false;
      let invoked = false;
      try {
        const couple = await Couple.findById(coupleId).exec();
        if (couple) { invoked = true; await dailyRewardService.recoverCouple(couple); }
      } catch (error) {
        failed = true;
        counts.errors++;
        throw error;
      } finally {
        addRecoveryCounts(total, counts);
        recoveryObserve('daily', failed ? 'error' : invoked ? 'ok' : 'empty', stageStarted, counts);
      }
    } catch (error) {
      wholeFailed = true;
      throw error;
    } finally {
      recoveryObserve('whole', wholeFailed ? 'error' : total.errors || total.deferred ? 'partial' : 'ok', started, total);
    }
  },
  async applyCoin(input: ApplyInput): Promise<{ balance: number }> {
    if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw Errors.badRequest('Delta phải là số nguyên khác 0');
    const result = await execute(input.coupleId, input.operationId, { actorUserId: input.actorUserId,
      allocations: { [input.ownerUserId]: input.delta }, exp: 0, reason: input.reason, refId: input.refId?.toString() ?? null });
    await realtimeAudience.couple(input.coupleId, ['wallet', 'couple']);
    return { balance: result.balances[input.ownerUserId] };
  },
  async reward(input: Omit<ApplyInput, 'delta' | 'ownerUserId'> & { coin: number; exp: number; ownerUserId?: string | null; allocations?: Record<string, number> }) {
    const couple = await Couple.findById(input.coupleId).exec();
    if (!couple) throw Errors.notFound('Couple không tồn tại');
    if (!Number.isSafeInteger(input.coin) || input.coin < 0) throw Errors.badRequest('Số Xu không hợp lệ');
    const allocations = input.allocations ?? (input.ownerUserId ? { [input.ownerUserId]: input.coin } : splitCoin(input.coin, couple.memberIds));
    if (Object.values(allocations).some(value => !Number.isSafeInteger(value) || value < 0)
      || Object.values(allocations).reduce((sum, value) => sum + value, 0) !== input.coin) throw Errors.badRequest('Phân bổ Xu không hợp lệ');
    const result = await execute(input.coupleId, input.operationId, { actorUserId: input.actorUserId, allocations,
      exp: input.exp, reason: input.reason, refId: input.refId?.toString() ?? null,
      ...(input.provenance ? { provenance: input.provenance } : {}) });
    await realtimeAudience.couple(input.coupleId, ['wallet', 'couple']);
    return { coin: result.balances[input.actorUserId], exp: result.exp, level: result.level, leveledUp: result.leveledUp };
  },
  async reconcileView(coupleId: Types.ObjectId, userId: string): Promise<void> {
    await ownWallet(coupleId, userId);
    await walletService.recoverRewards(coupleId);
  },
  async getSettledView(coupleId: Types.ObjectId, userId: string) {
    await walletService.reconcileView(coupleId, userId);
    const { wallet, couple } = await walletRepository.readSettled(coupleId, userId);
    const exp = couple.exp;
    const level = levelFromExp(exp);
    const view: WalletView = { coinBalance: wallet.balances[userId], ownerUserId: userId, exp, level,
      levelBaseExp: ECONOMY.levels[level - 1] ?? 0, nextLevelExp: level < ECONOMY.levels.length ? ECONOMY.levels[level] : null };
    return { wallet: view, couple };
  },
  async getView(coupleId: Types.ObjectId, userId: string): Promise<WalletView> {
    return (await walletService.getSettledView(coupleId, userId)).wallet;
  },
  async listLedgerPage(coupleId: Types.ObjectId, userId: string, input: { type?: LedgerType; limit: number; cursor?: string }) {
    const scope = `ledger:${coupleId}:${userId}:${input.type ?? 'all'}`;
    const before = decodeHistoryCursor(input.cursor, scope);
    await ownWallet(coupleId, userId);
    await walletService.recoverRewards(coupleId);
    const rows = await walletRepository.listLedgerPage(coupleId, userId, input.type, input.limit, before);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return { items: page.map(toLedgerView), nextCursor: rows.length > input.limit && last
      ? encodeHistoryCursor(scope, { createdAt: last.createdAt, id: last._id.toString() }) : null };
  },
  async listLedger(coupleId: Types.ObjectId, userId: string, type?: LedgerType): Promise<LedgerView[]> {
    await ownWallet(coupleId, userId);
    await walletService.recoverRewards(coupleId);
    return (await walletRepository.listLedger(coupleId, userId, type)).map(toLedgerView);
  },
};
