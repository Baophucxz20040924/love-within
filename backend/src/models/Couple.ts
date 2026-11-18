import { Schema, model, type Document, type Types } from 'mongoose';

export type CoupleStatus = 'active' | 'archived';
export interface DailyRewardPolicy { version: 2; effectiveDate: string; timezone: string; activatedAt: Date }

export interface CoupleDoc extends Document {
  _id: Types.ObjectId;
  memberIds: Types.ObjectId[]; // exactly 2
  dailyRewardPolicy?: DailyRewardPolicy | null;
  anniversaryDate: Date | null;
  level: number;
  exp: number;
  expRevision: number;
  expReceipt: { operationId: string; exp: number; level: number; leveledUp: boolean } | null;
  timezone: string;
  status: CoupleStatus;
  pinnedSavingsGoalId: Types.ObjectId | null;
  savingsWriteToken: string | null;
  savingsWriteStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const coupleSchema = new Schema<CoupleDoc>(
  {
    memberIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (v: Types.ObjectId[]) => v.length === 2,
        message: 'A couple must have exactly 2 members',
      },
    },
    // CAS create-once policy; no default inferred from time or source-row presence.
    dailyRewardPolicy: { type: Schema.Types.Mixed, default: null },
    pinnedSavingsGoalId: { type: Schema.Types.ObjectId, ref: 'SavingsGoal', default: null },
    // Non-expiring: an unknown write outcome requires offline reconciliation, never lease stealing.
    savingsWriteToken: { type: String, default: null },
    savingsWriteStartedAt: { type: Date, default: null },
    anniversaryDate: { type: Date, default: null },
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    expRevision: { type: Number, default: 0 },
    expReceipt: { type: Schema.Types.Mixed, default: null },
    timezone: { type: String, default: 'Asia/Ho_Chi_Minh' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

coupleSchema.index({ memberIds: 1 });

export const Couple = model<CoupleDoc>('Couple', coupleSchema);
