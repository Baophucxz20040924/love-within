import { Schema, model, type Document, type Types } from 'mongoose';

import type { RewardIntent } from './WalletOperation.js';

export interface CheckinDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  userId: Types.ObjectId;
  localDate: string; // YYYY-MM-DD in couple timezone
  streak: number;
  rewardIntent: RewardIntent | null;
  rewardCompletedAt: Date | null;
  dailySettlementPending?: boolean;
  sourceValid?: boolean;
  coinAwarded: number;
  expAwarded: number;
  createdAt: Date;
}

const checkinSchema = new Schema<CheckinDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    localDate: { type: String, required: true },
    streak: { type: Number, required: true, min: 1 },
    rewardIntent: { type: Schema.Types.Mixed, default: null },
    rewardCompletedAt: { type: Date, default: null },
    dailySettlementPending: { type: Boolean, default: false },
    sourceValid: { type: Boolean },
    coinAwarded: { type: Number, required: true },
    expAwarded: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One check-in per user per local day — the unique index is the anti-double-award guard.
checkinSchema.index({ coupleId: 1, userId: 1, localDate: 1 }, { unique: true });
checkinSchema.index({ coupleId: 1, localDate: 1 });
checkinSchema.index({ coupleId: 1, dailySettlementPending: 1, localDate: 1, _id: 1 });
checkinSchema.index({ coupleId: 1, rewardCompletedAt: 1, _id: 1 });

export const Checkin = model<CheckinDoc>('Checkin', checkinSchema);
