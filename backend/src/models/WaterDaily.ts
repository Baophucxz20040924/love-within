import { Schema, model, type Document, type Types } from 'mongoose';

/** Per-user daily aggregate for fast reads. Source of truth for totals is the sum of WaterLogs. */
export interface WaterDailyDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  userId: Types.ObjectId;
  localDate: string;
  totalMl: number;
  goalMl: number | null; // goal snapshot applicable that day
  goalMet: boolean;
  updatedAt: Date;
}

const waterDailySchema = new Schema<WaterDailyDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    localDate: { type: String, required: true },
    totalMl: { type: Number, default: 0, min: 0 },
    goalMl: { type: Number, default: null },
    goalMet: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

waterDailySchema.index({ coupleId: 1, userId: 1, localDate: 1 }, { unique: true });

export const WaterDaily = model<WaterDailyDoc>('WaterDaily', waterDailySchema);
