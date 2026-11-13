import { Types } from 'mongoose';
import { FriendNotification, type FriendNotificationDoc, type FriendNotificationType } from '../models/FriendNotification.js';

const RECENT_ACTORS = 3;

/** Only fields needed to decide visibility; no document hydration or display content. */
export type NotificationCandidate = Pick<FriendNotificationDoc, '_id' | 'type' | 'entityId' | 'actorIds' | 'recentActorIds' | 'readAt' | 'updatedAt'>;
const CANDIDATE_FIELDS = '_id type entityId actorIds recentActorIds readAt updatedAt';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export interface NotificationCursor {
  at: Date;
  id: Types.ObjectId;
}

/** Friends-space notifications. Every query is scoped by the recipient's userId. */
export const friendNotificationRepository = {
  /** One row per event (friend request, accepted request, joined through my link; poll_closed without an actor). */
  async add(userId: Types.ObjectId, type: FriendNotificationType, actorId: Types.ObjectId | null, entityId: Types.ObjectId | null): Promise<void> {
    const now = new Date();
    const actors = actorId ? [actorId] : [];
    await FriendNotification.create({
      userId,
      type,
      entityId,
      groupKey: null,
      actorIds: actors,
      recentActorIds: actors,
      readAt: null,
      createdAt: now,
      updatedAt: now,
    });
  },

  /**
   * One row per (recipient, type, post): adds the actor once, moves them to the front of the recent list,
   * marks the row unread again and bumps it to the top. A single atomic pipeline upsert (sent through the
   * driver: Mongoose does not cast update pipelines). If two first actors race, the unique (userId, groupKey)
   * index rejects the second insert and the retry updates the row the first one created.
   * Returns true when the actor is new on this row (Web Push only announces new people for some types).
   */
  async addGrouped(userId: Types.ObjectId, type: FriendNotificationType, actorId: Types.ObjectId, entityId: Types.ObjectId): Promise<boolean> {
    const groupKey = `${type}:${entityId.toString()}`;
    const now = new Date();
    const run = () =>
      FriendNotification.collection.findOneAndUpdate(
        { userId, groupKey },
        [
          {
            $set: {
              userId,
              type,
              entityId,
              groupKey,
              actorIds: { $setUnion: [{ $ifNull: ['$actorIds', []] }, [actorId]] },
              recentActorIds: {
                $slice: [
                  {
                    $concatArrays: [
                      [actorId],
                      { $filter: { input: { $ifNull: ['$recentActorIds', []] }, cond: { $ne: ['$$this', actorId] } } },
                    ],
                  },
                  RECENT_ACTORS,
                ],
              },
              readAt: null,
              createdAt: { $ifNull: ['$createdAt', now] },
              updatedAt: now,
            },
          },
        ],
        { upsert: true, returnDocument: 'before', projection: { actorIds: 1 } },
      );
    let before;
    try {
      before = await run();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      before = await run();
    }
    const known = (before?.actorIds ?? []) as Types.ObjectId[];
    return !known.some((id) => id.equals(actorId));
  },

  /** Newest first (by last activity). Fetches limit + 1 so the caller knows whether another page exists. */
  list(userId: Types.ObjectId, cursor: NotificationCursor | null, limit: number): Promise<FriendNotificationDoc[]> {
    const filter: Record<string, unknown> = { userId };
    if (cursor) filter.$or = [{ updatedAt: { $lt: cursor.at } }, { updatedAt: cursor.at, _id: { $lt: cursor.id } }];
    return FriendNotification.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).exec();
  },

  /** Visibility-only candidates since last seen. The caller includes one lookahead in its bounded limit. */
  listSince(userId: Types.ObjectId, since: Date | null, limit: number): Promise<NotificationCandidate[]> {
    const filter: Record<string, unknown> = { userId };
    if (since) filter.updatedAt = { $gt: since };
    return FriendNotification.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .select(CANDIDATE_FIELDS)
      .lean<NotificationCandidate[]>()
      .exec();
  },

  async markRead(userId: Types.ObjectId, id: string): Promise<boolean> {
    const res = await FriendNotification.updateOne({ _id: id, userId }, { $set: { readAt: new Date() } }).exec();
    return res.matchedCount > 0;
  },

  async markAllRead(userId: Types.ObjectId): Promise<void> {
    await FriendNotification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } }).exec();
  },

  async deleteForEntity(entityId: Types.ObjectId): Promise<void> {
    await FriendNotification.deleteMany({ entityId }).exec();
  },

  /** One type only, e.g. poll_closed when the author replaced the poll of a post. */
  async deleteForEntityOfType(entityId: Types.ObjectId, type: FriendNotificationType): Promise<void> {
    await FriendNotification.deleteMany({ entityId, type }).exec();
  },

  /**
   * Take one person off a grouped row (BB5: someone who said "Đi" changed their mind). The row goes when nobody is left;
   * otherwise it keeps its place and read state.
   */
  async removeGroupedActor(userId: Types.ObjectId, type: FriendNotificationType, entityId: Types.ObjectId, actorId: Types.ObjectId): Promise<void> {
    const groupKey = `${type}:${entityId.toString()}`;
    await FriendNotification.updateOne({ userId, groupKey }, { $pull: { actorIds: actorId, recentActorIds: actorId } }).exec();
    await FriendNotification.deleteOne({ userId, groupKey, actorIds: { $size: 0 } }).exec();
  },

  async deleteForEntities(entityIds: Types.ObjectId[]): Promise<void> {
    if (entityIds.length === 0) return;
    await FriendNotification.deleteMany({ entityId: { $in: entityIds } }).exec();
  },

  /** Unfriend / block: remove what each of the two did for the other (single rows go, grouped rows lose that person). */
  async purgeBetween(a: Types.ObjectId, b: Types.ObjectId): Promise<void> {
    for (const [to, from] of [
      [a, b],
      [b, a],
    ]) {
      await FriendNotification.deleteMany({ userId: to, groupKey: null, actorIds: from }).exec();
      await FriendNotification.updateMany(
        { userId: to, groupKey: { $type: 'string' }, actorIds: from },
        { $pull: { actorIds: from, recentActorIds: from } },
      ).exec();
      await FriendNotification.deleteMany({ userId: to, groupKey: { $type: 'string' }, actorIds: { $size: 0 } }).exec();
    }
  },
};
