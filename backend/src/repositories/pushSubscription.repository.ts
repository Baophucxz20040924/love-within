import type { Types } from 'mongoose';
import { PushSubscription, type PushSpace, type PushSubscriptionDoc } from '../models/PushSubscription.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export type PushSubscriptionRow = Pick<PushSubscriptionDoc, '_id' | 'endpoint' | 'keys'>;

/** Web Push devices (N4). Reads and deletes by the owner's userId, except the sender's own bookkeeping by _id. */
export const pushSubscriptionRepository = {
  /**
   * Save the device for this user and space. The endpoint is unique: the same device turned on by another user or in
   * the other space moves here (and starts with a clean fail count). Two first saves racing: the retry updates.
   */
  async upsert(input: { userId: Types.ObjectId; space: PushSpace; endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string }): Promise<PushSubscriptionDoc> {
    const run = () =>
      PushSubscription.findOneAndUpdate(
        { endpoint: input.endpoint },
        { $set: { userId: input.userId, space: input.space, keys: input.keys, userAgent: input.userAgent, failCount: 0 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
    try {
      return await run();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return run();
    }
  },

  /** Keep the `keep` most recently saved devices of a user in a space (bounds the fan-out of one push). */
  async pruneOldest(userId: Types.ObjectId, space: PushSpace, keep: number): Promise<number> {
    const old = await PushSubscription.find({ userId, space }).sort({ updatedAt: -1 }).skip(keep).select('_id').lean().exec();
    if (old.length === 0) return 0;
    const res = await PushSubscription.deleteMany({ _id: { $in: old.map((o) => o._id) } }).exec();
    return res.deletedCount;
  },

  listFor(userId: Types.ObjectId, space: PushSpace): Promise<PushSubscriptionRow[]> {
    return PushSubscription.find({ userId, space }).select('endpoint keys').lean<PushSubscriptionRow[]>().exec();
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
