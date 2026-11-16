import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { CoupleNotification, type CoupleNotificationDoc, type CoupleNotificationTarget } from '../models/CoupleNotification.js';
import { CoupleNotificationSnapshot } from '../models/CoupleNotificationSnapshot.js';
import type { CoupleNotificationType } from '../config/notificationTypes.js';

export interface CoupleNotificationScope { userId: Types.ObjectId; coupleId: Types.ObjectId }
export interface CoupleNotificationCursor { at: Date; id: Types.ObjectId }
export interface NewCoupleNotification extends CoupleNotificationScope {
  type: CoupleNotificationType;
  actorId: Types.ObjectId | null;
  entityId: Types.ObjectId | null;
  eventKey: string;
  target: CoupleNotificationTarget;
}
const duplicate = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

export const coupleNotificationRepository = {
  async addOnce(input: NewCoupleNotification): Promise<boolean> {
    try {
      const result = await CoupleNotification.updateOne(
        { userId: input.userId, coupleId: input.coupleId, eventKey: input.eventKey },
        { $setOnInsert: { ...input, createdAt: new Date(), readAt: null, seenAt: null } },
        { upsert: true, runValidators: true },
      ).exec();
      return result.upsertedCount > 0;
    } catch (err) {
      // The unique index arbitrates concurrent delivery of the same source event.
      if (duplicate(err)) return false;
      throw err;
    }
  },

  list(scope: CoupleNotificationScope, cursor: CoupleNotificationCursor | null, limit: number): Promise<CoupleNotificationDoc[]> {
    return CoupleNotification.find({ ...scope, ...(cursor ? { $or: [
      { createdAt: { $lt: cursor.at } }, { createdAt: cursor.at, _id: { $lt: cursor.id } },
    ] } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).exec();
  },

  async unseen(scope: CoupleNotificationScope, limit: number): Promise<number> {
    return (await CoupleNotification.find({ ...scope, seenAt: null }).select('_id').limit(limit).lean().exec()).length;
  },

  /** A stable opaque token for this exact page; reloading renews its 24-hour acknowledgement window. */
  async observe(scope: CoupleNotificationScope, notificationIds: Types.ObjectId[]): Promise<string> {
    const token = createHash('sha256').update(JSON.stringify([String(scope.userId), String(scope.coupleId), notificationIds.map(String)])).digest('hex');
    const update = { $setOnInsert: { ...scope, token, notificationIds }, $set: { expiresAt: new Date(Date.now() + 86_400_000) } };
    try { await CoupleNotificationSnapshot.updateOne({ ...scope, token }, update, { upsert: true }).exec(); }
    catch (err) {
      if (!duplicate(err)) throw err;
      await CoupleNotificationSnapshot.updateOne({ ...scope, token }, { $set: update.$set }).exec();
    }
    return token;
  },

  async observedIds(scope: CoupleNotificationScope, tokens: string[]): Promise<Types.ObjectId[] | null> {
    const unique = [...new Set(tokens)];
    const snapshots = await CoupleNotificationSnapshot.find({ ...scope, token: { $in: unique }, expiresAt: { $gt: new Date() } }).exec();
    if (snapshots.length !== unique.length) return null;
    return [...new Map(snapshots.flatMap((s) => s.notificationIds).map((id) => [String(id), id])).values()];
  },

  async markObserved(scope: CoupleNotificationScope, ids: Types.ObjectId[], field: 'seenAt' | 'readAt'): Promise<boolean> {
    if (!ids.length) return false;
    const result = await CoupleNotification.updateMany({ ...scope, _id: { $in: ids }, [field]: null }, { $set: { [field]: new Date() } }).exec();
    return result.modifiedCount > 0;
  },

  async markRead(scope: CoupleNotificationScope, id: Types.ObjectId): Promise<{ found: boolean; changed: boolean }> {
    const result = await CoupleNotification.updateOne({ ...scope, _id: id, readAt: null }, { $set: { readAt: new Date() } }).exec();
    if (result.matchedCount) return { found: true, changed: result.modifiedCount > 0 };
    return { found: !!await CoupleNotification.exists({ ...scope, _id: id }), changed: false };
  },
};
