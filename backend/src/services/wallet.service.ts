import { Types } from 'mongoose';
import { ECONOMY, levelFromExp } from '../config/economy.js';
import type { LedgerEntryDoc, LedgerReason, LedgerType } from '../models/LedgerEntry.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { walletRepository } from '../repositories/wallet.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface ApplyInput {
  coupleId: Types.ObjectId;
  actorUserId: string;
  delta: number;
  reason: LedgerReason;
  refId?: Types.ObjectId | null;
}

export interface WalletView {
  coinBalance: number;
  exp: number;
  level: number;
  /** Cumulative EXP at which the current level started (for a correct progress bar). */
  levelBaseExp: number;
  nextLevelExp: number | null;
}

export interface LedgerView {
  id: string;
  type: LedgerType;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  refId: string | null;
  actorUserId: string;
  createdAt: string;
}

function toLedgerView(e: LedgerEntryDoc): LedgerView {
  return {
    id: e._id.toString(),
    type: e.type,
    delta: e.delta,
    balanceAfter: e.balanceAfter,
    reason: e.reason,
    refId: e.refId ? e.refId.toString() : null,
    actorUserId: e.actorUserId.toString(),
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * The only place coin/EXP balances change. Every mutation is atomic ($inc) and
 * writes an immutable ledger entry (Requirements 9.2, 9.4, 9.5, 14.1).
 */
export const walletService = {
  async applyCoin(input: ApplyInput): Promise<{ balance: number }> {
    if (input.delta === 0) throw Errors.badRequest('Delta phải khác 0');
    // Common case: the wallet exists, so try the atomic update first and only create it when missing.
    let updated = await walletRepository.incCoin(input.coupleId, input.delta);
    if (!updated) {
      const wallet = await walletRepository.getOrCreate(input.coupleId);
      if (input.delta > 0) updated = await walletRepository.incCoin(input.coupleId, input.delta);
      if (!updated) {
        const missing = -input.delta - wallet.coinBalance;
        throw Errors.unprocessable(`Không đủ Xu (thiếu ${missing} Xu)`, { missing, balance: wallet.coinBalance });
      }
    }
    await walletRepository.appendLedger({
      coupleId: input.coupleId,
      type: 'coin',
      delta: input.delta,
      balanceAfter: updated.coinBalance,
      reason: input.reason,
      refId: input.refId ?? null,
      actorUserId: new Types.ObjectId(input.actorUserId),
    });
    logger.info('Coin applied', {
      coupleId: input.coupleId.toString(),
      userId: input.actorUserId,
      delta: input.delta,
      reason: input.reason,
      balance: updated.coinBalance,
    });
    return { balance: updated.coinBalance };
  },

  async applyExp(input: ApplyInput): Promise<{ exp: number; level: number; leveledUp: boolean }> {
    if (input.delta <= 0) throw Errors.badRequest('EXP delta phải > 0');
    const couple = await coupleRepository.incExp(input.coupleId, input.delta);
    if (!couple) throw Errors.notFound('Couple không tồn tại');

    const newLevel = levelFromExp(couple.exp);
    const leveledUp = newLevel > couple.level;
    if (newLevel !== couple.level) {
      await coupleRepository.setLevel(input.coupleId, newLevel);
    }
    await walletRepository.appendLedger({
      coupleId: input.coupleId,
      type: 'exp',
      delta: input.delta,
      balanceAfter: couple.exp,
      reason: input.reason,
      refId: input.refId ?? null,
      actorUserId: new Types.ObjectId(input.actorUserId),
    });
    logger.info('EXP applied', {
      coupleId: input.coupleId.toString(),
      userId: input.actorUserId,
      delta: input.delta,
      reason: input.reason,
      exp: couple.exp,
      level: newLevel,
    });
    return { exp: couple.exp, level: newLevel, leveledUp };
  },

  /** Convenience: award both coin and EXP for a completed action. */
  async reward(input: Omit<ApplyInput, 'delta'> & { coin: number; exp: number }) {
    // Coin lives on the Wallet and EXP on the Couple, so both updates can run at the same time.
    const [coin, exp] = await Promise.all([
      input.coin > 0 ? walletService.applyCoin({ ...input, delta: input.coin }) : null,
      input.exp > 0 ? walletService.applyExp({ ...input, delta: input.exp }) : null,
    ]);
    const results: { coin?: number; exp?: number; level?: number; leveledUp?: boolean } = {};
    if (coin) results.coin = coin.balance;
    if (exp) {
      results.exp = exp.exp;
      results.level = exp.level;
      results.leveledUp = exp.leveledUp;
    }
    return results;
  },

  async getView(coupleId: Types.ObjectId): Promise<WalletView> {
    const [wallet, couple] = await Promise.all([
      walletRepository.getOrCreate(coupleId),
      coupleRepository.findById(coupleId),
    ]);
    const exp = couple?.exp ?? 0;
    const level = levelFromExp(exp);
    const levelBaseExp = ECONOMY.levels[level - 1] ?? 0;
    const nextLevelExp = level < ECONOMY.levels.length ? ECONOMY.levels[level] : null;
    return { coinBalance: wallet.coinBalance, exp, level, levelBaseExp, nextLevelExp };
  },

  async listLedger(coupleId: Types.ObjectId, type?: LedgerType): Promise<LedgerView[]> {
    const entries = await walletRepository.listLedger(coupleId, type);
    return entries.map(toLedgerView);
  },
};
