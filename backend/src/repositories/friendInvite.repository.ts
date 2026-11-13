import { Types } from 'mongoose';
import { FriendInvite, FriendInviteUse, type FriendInviteDoc } from '../models/FriendInvite.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const friendInviteRepository = {
  /** Throws a duplicate-key error (11000) on the very unlikely code collision; the caller retries. */
  create(input: { code: string; inviterId: Types.ObjectId; maxUses: number; expiresAt: Date }): Promise<FriendInviteDoc> {
    return FriendInvite.create(input);
  },

  findByCode(code: string): Promise<FriendInviteDoc | null> {
    return FriendInvite.findOne({ code }).exec();
  },

  listByInviter(inviterId: Types.ObjectId): Promise<FriendInviteDoc[]> {
    return FriendInvite.find({ inviterId }).sort({ createdAt: -1 }).limit(20).exec();
  },

  revoke(id: string, inviterId: Types.ObjectId): Promise<FriendInviteDoc | null> {
    return FriendInvite.findOneAndUpdate({ _id: id, inviterId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true }).exec();
  },

  /** Count one more use only while the link is still valid (atomic, so the last seat cannot be taken twice). */
  async takeSeat(id: Types.ObjectId, now: Date): Promise<boolean> {
    const res = await FriendInvite.updateOne(
      { _id: id, revokedAt: null, expiresAt: { $gt: now }, $expr: { $lt: ['$uses', '$maxUses'] } },
      { $inc: { uses: 1 } },
    ).exec();
    return res.modifiedCount > 0;
  },

  /** Record that `userId` used the link. False when they already did (a person counts once per link). */
  async recordUse(inviteId: Types.ObjectId, userId: Types.ObjectId): Promise<boolean> {
    try {
      await FriendInviteUse.create({ inviteId, userId, usedAt: new Date() });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  },

  async forgetUse(inviteId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    await FriendInviteUse.deleteOne({ inviteId, userId }).exec();
  },
};
