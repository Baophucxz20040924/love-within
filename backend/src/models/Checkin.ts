import { Schema, model, type Document, type Types } from 'mongoose';

export interface CheckinDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  userId: Types.ObjectId;
  localDate: string; // YYYY-MM-DD in couple timezone
  streak: number;
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
    coinAwarded: { type: Number, required: true },
    expAwarded: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One check-in per user per local day — the unique index is the anti-double-award guard.
checkinSchema.index({ coupleId: 1, userId: 1, localDate: 1 }, { unique: true });

export const Checkin = model<CheckinDoc>('Checkin', checkinSchema);
