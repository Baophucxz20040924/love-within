import type { Types } from 'mongoose';
import { PairingInvite, type PairingInviteDoc, type InviteStatus } from '../models/PairingInvite.js';

export const pairingInviteRepository = {
  findById(id: string | Types.ObjectId): Promise<PairingInviteDoc | null> {
    return PairingInvite.findById(id).exec();
  },

  create(input: {
    fromUserId: Types.ObjectId;
    toEmail: string;
    expiresAt: Date;
  }): Promise<PairingInviteDoc> {
    return PairingInvite.create(input);
  },

  findPendingSentBy(fromUserId: Types.ObjectId): Promise<PairingInviteDoc[]> {
    return PairingInvite.find({ fromUserId, status: 'pending' }).sort({ createdAt: -1 }).exec();
  },

  findPendingReceivedBy(email: string): Promise<PairingInviteDoc[]> {
    return PairingInvite.find({ toEmail: email.toLowerCase(), status: 'pending' })
      .sort({ createdAt: -1 })
      .exec();
  },

  findPendingBetween(fromUserId: Types.ObjectId, toEmail: string): Promise<PairingInviteDoc | null> {
    return PairingInvite.findOne({ fromUserId, toEmail: toEmail.toLowerCase(), status: 'pending' }).exec();
  },

  async setStatus(id: Types.ObjectId, status: InviteStatus): Promise<void> {
    await PairingInvite.updateOne({ _id: id }, { $set: { status } }).exec();
  },

  /** Cancel all other pending invites involving either user once a couple forms. */
  async cancelPendingFor(userIds: Types.ObjectId[], emails: string[]): Promise<void> {
    await PairingInvite.updateMany(
      {
        status: 'pending',
        $or: [{ fromUserId: { $in: userIds } }, { toEmail: { $in: emails.map((e) => e.toLowerCase()) } }],
      },
      { $set: { status: 'cancelled' } },
    ).exec();
  },
};
