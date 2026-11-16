import type { Types } from 'mongoose';
import { PushSubscription, type PushSubscriptionDoc } from '../models/PushSubscription.js';
import { Errors } from '../utils/errors.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export type PushSubscriptionRow = Pick<PushSubscriptionDoc, '_id' | 'userId' | 'credentialVersion' | 'endpoint' | 'keys'>;

/** Web Push devices (N4). Reads and deletes by the owner's userId, except the sender's own bookkeeping by _id. */
export const pushSubscriptionRepository = {
  /**
   * Save the device for this account. The endpoint is unique: the same device turned on by another user moves here
   * (and starts with a clean fail count). Two first saves racing: the retry updates. Legacy space metadata is ignored.
   */
  async upsert(input: { userId: Types.ObjectId; credentialVersion: number; endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string }): Promise<PushSubscriptionDoc> {
    if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 0) {
      throw Errors.unauthorized('Phiên đăng nhập không hợp lệ');
    }
    // A delayed pre-reset registration must not overwrite a newer generation for the same account.
    // Different-account ownership transfer is still allowed; a missing legacy version means zero.
    const filter = { endpoint: input.endpoint, $or: [
      { userId: { $ne: input.userId } },
      { credentialVersion: { $lte: input.credentialVersion } },
      { credentialVersion: { $exists: false } },
    ] };
    const update = { $set: { userId: input.userId, credentialVersion: input.credentialVersion, keys: input.keys, userAgent: input.userAgent, failCount: 0 } };
    try {
      const saved = await PushSubscription.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true }).exec();
      if (saved) return saved;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Concurrent first registration, or same endpoint at a newer credential version.
      // Retry ONLY the guarded update, not another insert or unguarded overwrite.
      const saved = await PushSubscription.findOneAndUpdate(filter, update, { new: true }).exec();
      if (saved) return saved;
    }
    throw Errors.conflict('Thiết bị đã đổi phiên đăng nhập. Vui lòng đăng ký thông báo lại.');
  },

  /** Keep the `keep` most recently saved devices account-wide (bounds the fan-out of one push). */
  async pruneOldest(userId: Types.ObjectId, keep: number): Promise<number> {
    const old = await PushSubscription.find({ userId }).sort({ updatedAt: -1 }).skip(keep).select('_id').lean().exec();
    if (old.length === 0) return 0;
    // Recheck ownership in case an endpoint moved to another account after the read.
    const res = await PushSubscription.deleteMany({ userId, _id: { $in: old.map((o) => o._id) } }).exec();
    return res.deletedCount;
  },

  listFor(userId: Types.ObjectId): Promise<PushSubscriptionRow[]> {
    return PushSubscription.find({ userId }).select('userId credentialVersion endpoint keys').lean<PushSubscriptionRow[]>().exec();
  },

  findOwn(userId: Types.ObjectId, endpoint: string): Promise<PushSubscriptionDoc | null> {
    return PushSubscription.findOne({ userId, endpoint }).exec();
  },

  /** Only the owner's row: another user's endpoint is left alone. */
  async deleteOwn(userId: Types.ObjectId, endpoint: string): Promise<boolean> {
    const res = await PushSubscription.deleteOne({ userId, endpoint }).exec();
    return res.deletedCount > 0;
  },

  async markSuccess(id: Types.ObjectId): Promise<void> {
    await PushSubscription.updateOne({ _id: id }, { $set: { lastSuccessAt: new Date(), failCount: 0 } }).exec();
  },

  /** Count one failed send; returns the new count (null when the row is gone). */
  async incFail(id: Types.ObjectId): Promise<number | null> {
    const doc = await PushSubscription.findOneAndUpdate({ _id: id }, { $inc: { failCount: 1 } }, { new: true }).select('failCount').lean().exec();
    return doc ? doc.failCount : null;
  },

  async deleteById(id: Types.ObjectId): Promise<void> {
    await PushSubscription.deleteOne({ _id: id }).exec();
  },
};
