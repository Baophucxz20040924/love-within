import type { Types } from 'mongoose';
import { BankConnection, type BankConnectionDoc } from '../models/BankConnection.js';
import type { EncryptedSecret } from '../utils/crypto.js';

/** Every query is scoped by userId: a connection belongs to exactly one user. */
export const bankConnectionRepository = {
  findByUser(userId: string | Types.ObjectId): Promise<BankConnectionDoc | null> {
    return BankConnection.findOne({ userId }).exec();
  },

  /** Create the user's connection, or re-activate a revoked one (keeps the same _id). */
  upsertActive(
    userId: string | Types.ObjectId,
    input: { accountLast4: string; tokenEnc: EncryptedSecret; at: Date },
  ): Promise<BankConnectionDoc> {
    return BankConnection.findOneAndUpdate(
      { userId },
      {
        $set: {
          provider: 'thueapibank',
          bankBrand: 'MBBANK',
          accountLast4: input.accountLast4,
          tokenEnc: input.tokenEnc,
          status: 'active',
          lastPolledAt: input.at,
          lastSuccessAt: input.at,
          lastError: null,
          consecutiveErrors: 0,
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).exec() as Promise<BankConnectionDoc>;
  },

  listActive(): Promise<BankConnectionDoc[]> {
    return BankConnection.find({ status: 'active', tokenEnc: { $ne: null } }).exec();
  },

  /** Successful poll. Never revives a revoked connection (disconnect may race with a running poll). */
  async recordSuccess(id: Types.ObjectId, at: Date): Promise<BankConnectionDoc | null> {
    return BankConnection.findOneAndUpdate(
      { _id: id, status: { $ne: 'revoked' } },
      { $set: { status: 'active', lastPolledAt: at, lastSuccessAt: at, lastError: null, consecutiveErrors: 0 } },
      { new: true },
    ).exec();
  },

  /** Failed poll. Moves to 'error' after `threshold` consecutive failures, or immediately when `fatal`. */
  async recordFailure(
    id: Types.ObjectId,
    at: Date,
    error: string,
    threshold: number,
    fatal: boolean,
  ): Promise<BankConnectionDoc | null> {
    const doc = await BankConnection.findOneAndUpdate(
      { _id: id, status: { $ne: 'revoked' } },
      { $set: { lastPolledAt: at, lastError: error }, $inc: { consecutiveErrors: 1 } },
      { new: true },
    ).exec();
    if (doc && doc.status === 'active' && (fatal || doc.consecutiveErrors >= threshold)) {
      return BankConnection.findOneAndUpdate({ _id: id, status: 'active' }, { $set: { status: 'error' } }, { new: true }).exec();
    }
    return doc;
  },

  /** Disconnect: drop the token, keep the row so re-linking reuses it. */
  revoke(userId: string | Types.ObjectId): Promise<BankConnectionDoc | null> {
    return BankConnection.findOneAndUpdate(
      { userId },
      { $set: { status: 'revoked', tokenEnc: null, lastError: null, consecutiveErrors: 0 } },
      { new: true },
    ).exec();
  },
};
