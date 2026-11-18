import { Types } from 'mongoose';
import { Wallet, type WalletDoc, type WalletPending } from '../models/Wallet.js';
import { Couple } from '../models/Couple.js';
import { LedgerEntry, type LedgerType } from '../models/LedgerEntry.js';
import { WalletOperation, type OperationPayload, type OperationResult } from '../models/WalletOperation.js';
import { AppError, Errors } from '../utils/errors.js';

export const walletReview = () => new AppError(503, 'WALLET_REVIEW_REQUIRED', 'Ví đang chờ đối soát. Vui lòng thử lại sau.');
export const duplicateKey = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
export function sortedMembers(ids: readonly (string | Types.ObjectId)[]): string[] {
  const members = ids.map(String).sort();
  if (members.length !== 2 || members[0] === members[1] || members.some((id) => !/^[a-f0-9]{24}$/.test(id))) throw walletReview();
  return members;
}
export function splitCoin(total: number, ids: readonly (string | Types.ObjectId)[]): Record<string, number> {
  if (!Number.isSafeInteger(total) || total < 0) throw walletReview();
  const [first, second] = sortedMembers(ids);
  return { [first]: Math.ceil(total / 2), [second]: Math.floor(total / 2) };
}

export const walletRepository = {
  async getOrCreate(coupleId: Types.ObjectId): Promise<WalletDoc> {
    const couple = await Couple.findById(coupleId).exec();
    if (!couple) throw Errors.notFound('Couple không tồn tại');
    const members = sortedMembers(couple.memberIds);
    let wallet = await Wallet.findOne({ coupleId }).exec();
    if (!wallet) {
      try {
        wallet = await Wallet.findOneAndUpdate({ coupleId }, { $setOnInsert: {
          coupleId, coinBalance: 0, version: 2, memberIds: members, balances: splitCoin(0, members), revision: 0,
        } }, { new: true, upsert: true }).exec();
      } catch (error) {
        if (!duplicateKey(error)) throw error;
        wallet = await Wallet.findOne({ coupleId }).exec();
      }
    }
    if (!wallet) throw walletReview();
    if (wallet.version !== 2) {
      if (wallet.version != null && wallet.version !== 1) throw walletReview();
      // Equality of the raw balance is part of the CAS. The pipeline computes from the database value,
      // not a client snapshot; the immutable audit and both allocations are written in the same update.
      const raw = await Wallet.collection.findOne({ _id: wallet._id });
      if (!raw || typeof raw.coinBalance !== 'number') throw walletReview();
      splitCoin(raw.coinBalance, members);
      const allocations = {
        [members[0]]: { $ceil: { $divide: ['$coinBalance', 2] } },
        [members[1]]: { $floor: { $divide: ['$coinBalance', 2] } },
      };
      await Wallet.updateOne({ _id: wallet._id, version: { $ne: 2 }, coinBalance: wallet.coinBalance }, [{ $set: {
        version: 2, memberIds: members, balances: allocations, revision: 0, pending: null,
        migration: { originalBalance: '$coinBalance', allocations, migratedAt: '$$NOW' },
      } }]).exec();
      wallet = await Wallet.findOne({ coupleId }).exec();
    }
    if (!wallet || wallet.version !== 2 || JSON.stringify(wallet.memberIds) !== JSON.stringify(members)
      || !Number.isSafeInteger(wallet.revision) || wallet.revision < 0
      || Object.keys(wallet.balances ?? {}).length !== 2
      || members.some((id) => !Number.isSafeInteger(wallet!.balances[id]) || wallet!.balances[id] < 0)) throw walletReview();
    return wallet;
  },

  findOperation(id: string) { return WalletOperation.findById(id).exec(); },
  async ensureOperation(id: string, coupleId: Types.ObjectId, payload: OperationPayload, fingerprint: string) {
    try {
      return await WalletOperation.findOneAndUpdate({ _id: id }, { $setOnInsert: { coupleId, payload, fingerprint } }, { upsert: true, new: true }).exec();
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      return WalletOperation.findById(id).orFail().exec();
    }
  },
  /** Balance mutation and the sole pending receipt are inseparable. Revision fences stale workers after clear. */
  apply(coupleId: Types.ObjectId, revision: number, balances: Record<string, number>, pending: WalletPending) {
    return Wallet.findOneAndUpdate({ coupleId, version: 2, revision, pending: null }, {
      $set: { balances, pending }, $inc: { revision: 1 },
    }, { new: true }).exec();
  },
  async commit(id: string, result: OperationResult, rejected: boolean) {
    await WalletOperation.updateOne({ _id: id, status: 'pending' }, { $set: { status: rejected ? 'rejected' : 'committed', result } }).exec();
  },
  async clear(coupleId: Types.ObjectId, pending: WalletPending) {
    await Wallet.updateOne({ coupleId, 'pending.operationId': pending.operationId, 'pending.revision': pending.revision }, {
      $set: { pending: null }, $inc: { revision: 1 },
    }).exec();
  },
  async appendLedger(input: {
    operationKey: string; coupleId: Types.ObjectId; type: LedgerType; delta: number; balanceAfter: number;
    reason: OperationPayload['reason']; refId: Types.ObjectId | null; actorUserId: Types.ObjectId; ownerUserId: Types.ObjectId | null;
    provenance?: OperationPayload['provenance'];
  }) {
    try {
      await LedgerEntry.updateOne({ operationKey: input.operationKey }, { $setOnInsert: input }, { upsert: true }).exec();
    } catch (error) { if (!duplicateKey(error)) throw error; }
  },
  listLedger(coupleId: Types.ObjectId, ownerUserId: string, type?: LedgerType, limit = 50) {
    return LedgerEntry.find({ coupleId, ...(type ? { type } : {}), $or: [
      { type: 'exp' }, { ownerUserId: new Types.ObjectId(ownerUserId) }, { type: 'coin', ownerUserId: null },
    ] }).sort({ createdAt: -1, _id: -1 }).limit(limit).exec();
  },
};
