import { Schema, model, type Document, type Types } from 'mongoose';

/** pending = friend request waiting for the recipient; accepted = friends. Declined, cancelled and unfriended rows are deleted. */
export const FRIENDSHIP_STATUSES = ['pending', 'accepted'] as const;
export type FriendshipStatus = (typeof FRIENDSHIP_STATUSES)[number];

export interface FriendshipDoc extends Document {
  _id: Types.ObjectId;
  requesterId: Types.ObjectId;
  recipientId: Types.ObjectId;
  /** "<smaller id>:<larger id>": one row per pair whatever the direction (unique index). */
  pairKey: string;
  status: FriendshipStatus;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const friendshipSchema = new Schema<FriendshipDoc>(
  {
    requesterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pairKey: { type: String, required: true },
    status: { type: String, enum: FRIENDSHIP_STATUSES, default: 'pending' },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Two people can never have two rows (e.g. both sending a request at the same moment).
friendshipSchema.index({ pairKey: 1 }, { unique: true });
friendshipSchema.index({ requesterId: 1, status: 1 });
friendshipSchema.index({ recipientId: 1, status: 1 });

export const Friendship = model<FriendshipDoc>('Friendship', friendshipSchema);
