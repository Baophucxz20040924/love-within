import type { Types } from 'mongoose';
import { Wallet, type WalletDoc } from '../models/Wallet.js';
import { LedgerEntry, type LedgerEntryDoc, type LedgerReason, type LedgerType } from '../models/LedgerEntry.js';

export const walletRepository = {
  /** Get or lazily create the couple wallet. */
  getOrCreate(coupleId: Types.ObjectId): Promise<WalletDoc> {
    return Wallet.findOneAndUpdate(
      { coupleId },
      { $setOnInsert: { coupleId, coinBalance: 0 } },
      { new: true, upsert: true },
    ).exec();
  },

  /**
   * Atomically add coins. For negative deltas the filter requires sufficient balance,
   * so concurrent spends can never push the balance below zero. Returns null if rejected.
   */
  incCoin(coupleId: Types.ObjectId, delta: number): Promise<WalletDoc | null> {
    const filter: Record<string, unknown> = { coupleId };
    if (delta < 0) filter.coinBalance = { $gte: -delta };
    return Wallet.findOneAndUpdate(filter, { $inc: { coinBalance: delta } }, { new: true }).exec();
  },

  appendLedger(input: {
    coupleId: Types.ObjectId;
    type: LedgerType;
    delta: number;
    balanceAfter: number;
    reason: LedgerReason;
    refId: Types.ObjectId | null;
    actorUserId: Types.ObjectId;
  }): Promise<LedgerEntryDoc> {
    return LedgerEntry.create(input);
  },

  listLedger(coupleId: Types.ObjectId, type?: LedgerType, limit = 50): Promise<LedgerEntryDoc[]> {
    const filter: Record<string, unknown> = { coupleId };
    if (type) filter.type = type;
    return LedgerEntry.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  },
};
