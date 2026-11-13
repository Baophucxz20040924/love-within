import { Schema, model, type Document, type Types } from 'mongoose';

export interface CoupleSettingsDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  waterGoalMl: number | null; // applies per member per day
  waterGoalScope: 'per_user' | 'shared';
  updatedAt: Date;
}

const settingsSchema = new Schema<CoupleSettingsDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true, unique: true },
    waterGoalMl: { type: Number, default: null, min: 1 },
    waterGoalScope: { type: String, enum: ['per_user', 'shared'], default: 'per_user' },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const CoupleSettings = model<CoupleSettingsDoc>('CoupleSettings', settingsSchema);
