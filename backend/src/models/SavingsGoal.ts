import { Schema, model, type Document, type Types } from 'mongoose';

export type SavingsStatus = 'active' | 'reached' | 'closed';
export interface SavingsGoalDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  title: string;
  emoji: string;
  targetVnd: number;
  dueOn: string | null;
  status: SavingsStatus;
  reachedAt: Date | null;
  createdBy: Types.ObjectId;
  /** Configuration version, independent of entries and reached status. */
  version: number;
  /** Durable effects journal: retries of old proposals cannot overwrite newer decisions. */
  appliedProposalIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<SavingsGoalDoc>({
  coupleId: { type: Schema.Types.ObjectId, required: true, ref: 'Couple' },
  title: { type: String, required: true, maxlength: 120 },
  emoji: { type: String, required: true, maxlength: 16 },
  targetVnd: { type: Number, required: true, min: 100_000, max: 10_000_000_000 },
  dueOn: { type: String, default: null },
  status: { type: String, enum: ['active', 'reached', 'closed'], default: 'active' },
  reachedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  version: { type: Number, default: 1 },
  appliedProposalIds: { type: [Schema.Types.ObjectId], default: [] },
}, { timestamps: true });
schema.index({ coupleId: 1, createdAt: -1, _id: -1 });
schema.index({ coupleId: 1, status: 1, createdAt: -1, _id: -1 });
export const SavingsGoal = model<SavingsGoalDoc>('SavingsGoal', schema);
