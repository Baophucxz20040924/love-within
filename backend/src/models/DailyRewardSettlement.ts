import { Schema, model, type Document, type Types } from 'mongoose';
import type { RewardIntent } from './WalletOperation.js';

export type DailyRewardComponent = 'checkin_pair' | 'photo_base' | 'timely_pair_bonus';
export interface DailyRewardSettlementDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  localDate: string;
  component: DailyRewardComponent;
  beneficiary: string; // member ID for photo_base; 'pair' for pair rewards
  memberIds: string[];
  commonStreak: number | null;
  baseCoin: number;
  bonusCoin: number;
  intent: RewardIntent;
  completedAt: Date | null;
  createdAt: Date;
}
const schema = new Schema<DailyRewardSettlementDoc>({
  coupleId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  localDate: { type: String, required: true, immutable: true },
  component: { type: String, enum: ['checkin_pair', 'photo_base', 'timely_pair_bonus'], required: true, immutable: true },
  beneficiary: { type: String, required: true, immutable: true },
  memberIds: { type: [String], required: true, immutable: true },
  commonStreak: { type: Number, default: null, immutable: true },
  baseCoin: { type: Number, required: true, immutable: true },
  bonusCoin: { type: Number, required: true, immutable: true },
  intent: { type: Schema.Types.Mixed, required: true, immutable: true },
  completedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ coupleId: 1, localDate: 1, component: 1, beneficiary: 1 }, { unique: true });
schema.index({ coupleId: 1, completedAt: 1, localDate: 1 });
export const DailyRewardSettlement = model<DailyRewardSettlementDoc>('DailyRewardSettlement', schema);
