import { Schema, model, type Document, type Types } from 'mongoose';

/** Invite links into the friends space (plan/ENGINEERING_WORKFLOW.md, BB4). */

export const INVITE_DAYS = [1, 7, 30] as const;
export const INVITE_USES = [1, 5, 20] as const;
export const INVITE_CODE_LENGTH = 10;

export interface FriendInviteDoc extends Document {
  _id: Types.ObjectId;
  /** 10 random base62 characters (~59 bits), the secret part of /j/<code>. */
  code: string;
  inviterId: Types.ObjectId;
  maxUses: number;
  uses: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

const inviteSchema = new Schema<FriendInviteDoc>(
  {
    code: { type: String, required: true },
    inviterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    maxUses: { type: Number, required: true, min: 1 },
    uses: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inviteSchema.index({ code: 1 }, { unique: true });
inviteSchema.index({ inviterId: 1, createdAt: -1 });

export const FriendInvite = model<FriendInviteDoc>('FriendInvite', inviteSchema);

/** Who used which link: a person counts once per link. */
export interface FriendInviteUseDoc extends Document {
  _id: Types.ObjectId;
  inviteId: Types.ObjectId;
  userId: Types.ObjectId;
  usedAt: Date;
}

const inviteUseSchema = new Schema<FriendInviteUseDoc>({
  inviteId: { type: Schema.Types.ObjectId, ref: 'FriendInvite', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  usedAt: { type: Date, required: true },
});

inviteUseSchema.index({ inviteId: 1, userId: 1 }, { unique: true });

export const FriendInviteUse = model<FriendInviteUseDoc>('FriendInviteUse', inviteUseSchema);
