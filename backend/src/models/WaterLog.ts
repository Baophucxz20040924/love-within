import { Schema, model, type Document, type Types } from 'mongoose';

export type WaterSource = 'ai' | 'manual';
/** pending → the partner must approve before the ml counts toward the daily total. */
export type WaterLogStatus = 'pending' | 'approved' | 'rejected';

export interface WaterLogDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  userId: Types.ObjectId;
  localDate: string;
  amountMl: number;
  source: WaterSource;
  aiRaw: Record<string, unknown> | null; // compact raw AI result for debugging
  imageKey: string | null; // S3 object key, never a public URL
  status: WaterLogStatus;
  reviewedBy: Types.ObjectId | null; // partner who approved/rejected, or the submitter when withdrawn
  reviewedAt: Date | null;
  createdAt: Date;
}

const waterLogSchema = new Schema<WaterLogDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    localDate: { type: String, required: true },
    amountMl: { type: Number, required: true, min: 1 },
    source: { type: String, enum: ['ai', 'manual'], required: true },
    aiRaw: { type: Schema.Types.Mixed, default: null },
    imageKey: { type: String, default: null },
    // No default on purpose: every write states its status explicitly. Rows created before
    // approvals existed have no status and were already counted, so readers treat them as approved.
    status: { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

waterLogSchema.index({ coupleId: 1, userId: 1, localDate: 1 });
waterLogSchema.index({ coupleId: 1, status: 1, createdAt: -1 });

export const WaterLog = model<WaterLogDoc>('WaterLog', waterLogSchema);
