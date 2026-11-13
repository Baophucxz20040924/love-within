import { Types } from 'mongoose';
import { Friendship, type FriendshipDoc } from '../models/Friendship.js';
import { FriendBlock } from '../models/FriendSafety.js';

type Id = string | Types.ObjectId;

/** One key per pair, independent of who sent the request. */
export function pairKeyOf(a: Id, b: Id): string {
  const [x, y] = [a.toString(), b.toString()].sort();
  return `${x}:${y}`;
}

/** The other person in a friendship row. */
export function otherOf(f: Pick<FriendshipDoc, 'requesterId' | 'recipientId'>, userId: Id): Types.ObjectId {
  return f.requesterId.toString() === userId.toString() ? f.recipientId : f.requesterId;
}

const involving = (userId: Id) => ({ $or: [{ requesterId: userId }, { recipientId: userId }] });

/** Friends space: scoped by the caller's userId (the caller must be one side of every row it touches). */
export const friendshipRepository = {
  create(requesterId: Types.ObjectId, recipientId: Types.ObjectId): Promise<FriendshipDoc> {
    return Friendship.create({ requesterId, recipientId, pairKey: pairKeyOf(requesterId, recipientId) });
  },

  findBetween(a: Id, b: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOne({ pairKey: pairKeyOf(a, b) }).exec();
  },

  /** Every row (requests and friends) involving the user. */
  listFor(userId: Id): Promise<FriendshipDoc[]> {
    return Friendship.find(involving(userId)).sort({ updatedAt: -1 }).limit(5000).exec();
  },

  /** Rows between the user and each of `others` (for search results). */
  listBetween(userId: Id, others: Id[]): Promise<FriendshipDoc[]> {
    if (others.length === 0) return Promise.resolve([]);
    return Friendship.find({ pairKey: { $in: others.map((o) => pairKeyOf(userId, o)) } }).exec();
  },

  /**
   * Fresh accepted, unblocked pairs only. Event pages supply at most 50 × 100 creator/invitee pairs,
   * not every friend of every creator. Deduplicate and chunk through the existing unique pairKey index.
   * Explicit blocks win even if an accepted friendship row was retained.
   */
  async acceptedUnblockedPairKeys(pairs: readonly (readonly [Id, Id])[]): Promise<Set<string>> {
    const keys = [...new Set(pairs.map(([a, b]) => pairKeyOf(a, b)))];
    const accepted = new Set<string>();
    const chunkSize = 500;
    for (let offset = 0; offset < keys.length; offset += chunkSize) {
      const rows = await Friendship.find({ pairKey: { $in: keys.slice(offset, offset + chunkSize) }, status: 'accepted' })
        .hint({ pairKey: 1 })
        .select('-_id pairKey requesterId recipientId')
        .lean()
        .exec();
      if (rows.length === 0) continue;
      const blocks = await FriendBlock.find({
        $or: rows.flatMap((r) => [
          { blockerId: r.requesterId, blockedId: r.recipientId },
          { blockerId: r.recipientId, blockedId: r.requesterId },
        ]),
      }).select('-_id blockerId blockedId').lean().exec();
      const blocked = new Set(blocks.map((b) => pairKeyOf(b.blockerId, b.blockedId)));
      for (const row of rows) {
        if (!blocked.has(row.pairKey)) accepted.add(row.pairKey);
      }
    }
    return accepted;
  },

  async friendIds(userId: Id): Promise<Types.ObjectId[]> {
    const rows = await Friendship.find({ status: 'accepted', ...involving(userId) })
      .select('requesterId recipientId')
      .limit(5000)
      .lean()
      .exec();
    return rows.map((r) => otherOf(r, userId));
  },

  /**
   * Friendships that involve at least one of `ids` (friend suggestions, BB7): both ids of each row only, at most `limit` rows.
   * Uses the two (requesterId, status) / (recipientId, status) indexes.
   */
  acceptedTouching(ids: Types.ObjectId[], limit: number): Promise<{ requesterId: Types.ObjectId; recipientId: Types.ObjectId }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return Friendship.find({ status: 'accepted', $or: [{ requesterId: { $in: ids } }, { recipientId: { $in: ids } }] })
      .select('-_id requesterId recipientId')
      .limit(limit)
      .lean<{ requesterId: Types.ObjectId; recipientId: Types.ObjectId }[]>()
      .exec();
  },

  async areFriends(a: Id, b: Id): Promise<boolean> {
    return (await Friendship.exists({ pairKey: pairKeyOf(a, b), status: 'accepted' }).exec()) !== null;
  },

  findPendingForRecipient(id: Id, recipientId: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOne({ _id: id, recipientId, status: 'pending' }).exec();
  },

  /** Only the recipient can accept, and only a pending request (atomic, so a double tap accepts once). */
  accept(id: Id, recipientId: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOneAndUpdate(
      { _id: id, recipientId, status: 'pending' },
      { $set: { status: 'accepted', acceptedAt: new Date() } },
      { new: true },
    ).exec();
  },

  /** Decline (recipient) or cancel (requester) a pending request. */
  deletePending(id: Id, userId: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOneAndDelete({ _id: id, status: 'pending', ...involving(userId) }).exec();
  },

  /** Unfriend. */
  deleteAccepted(a: Id, b: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOneAndDelete({ pairKey: pairKeyOf(a, b), status: 'accepted' }).exec();
  },

  /** Remove whatever links two people, request or friendship (blocking). */
  async deleteBetween(a: Id, b: Id): Promise<void> {
    await Friendship.deleteOne({ pairKey: pairKeyOf(a, b) }).exec();
  },

  countFriends(userId: Id): Promise<number> {
    return Friendship.countDocuments({ status: 'accepted', ...involving(userId) }).exec();
  },

  /** Persisted blocks win over pending rows retained after interrupted block cleanup. */
  countIncomingPending(userId: Id, blocked: ReadonlySet<string>): Promise<number> {
    return Friendship.countDocuments({ recipientId: userId, status: 'pending', requesterId: { $nin: [...blocked] } }).exec();
  },

  /** Which of `ids` are still requests waiting for `userId` (notifications drop answered ones). */
  async pendingIncomingIds(userId: Id, ids: Types.ObjectId[], blocked: ReadonlySet<string>): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await Friendship.find({ _id: { $in: ids }, recipientId: userId, status: 'pending', requesterId: { $nin: [...blocked] } }).select('_id').lean().exec();
    return new Set(rows.map((r) => r._id.toString()));
  },

  /** Invite links: friends straight away (the inviter agreed by sharing the link, the guest by using it). */
  createAccepted(requesterId: Types.ObjectId, recipientId: Types.ObjectId): Promise<FriendshipDoc> {
    return Friendship.create({
      requesterId,
      recipientId,
      pairKey: pairKeyOf(requesterId, recipientId),
      status: 'accepted',
      acceptedAt: new Date(),
    });
  },

  /** Accept a pending row whoever sent it (invite links). */
  acceptAny(id: Id): Promise<FriendshipDoc | null> {
    return Friendship.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'accepted', acceptedAt: new Date() } }, { new: true }).exec();
  },
};
