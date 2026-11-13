import { Schema, model, type Document, type Types } from 'mongoose';

export type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

export interface PairingInviteDoc extends Document {
  _id: Types.ObjectId;
  fromUserId: Types.ObjectId;
  toEmail: string;
  status: InviteStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<PairingInviteDoc>(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toEmail: { type: String, required: true, lowercase: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'cancelled', 'expired'],
      default: 'pending',
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

inviteSchema.index({ toEmail: 1, status: 1 });
inviteSchema.index({ fromUserId: 1, status: 1 });

export const PairingInvite = model<PairingInviteDoc>('PairingInvite', inviteSchema);
