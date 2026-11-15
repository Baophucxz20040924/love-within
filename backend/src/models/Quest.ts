import { Schema, model, type Document, type Types } from 'mongoose';

import type { RewardIntent } from './WalletOperation.js';

export type QuestType = 'water_goal' | 'checkin' | 'custom_boolean' | 'daily_question' | 'duo_moment';
export const QUEST_TYPES: readonly QuestType[] = ['water_goal', 'checkin', 'custom_boolean', 'daily_question', 'duo_moment'];

/** Quest catalog (global definitions). Progress per couple/day lives in QuestProgress. */
export interface QuestDoc extends Document {
  _id: Types.ObjectId;
  key: string;
  title: string;
  description: string;
  type: QuestType;
  coinReward: number;
  expReward: number;
  active: boolean;
}

const questSchema = new Schema<QuestDoc>({
  key: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  type: { type: String, enum: [...QUEST_TYPES], required: true },
  coinReward: { type: Number, required: true, min: 0 },
  expReward: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true },
});

export const Quest = model<QuestDoc>('Quest', questSchema);

export type QuestProgressStatus = 'in_progress' | 'completed' | 'rewarded';

export interface QuestProgressDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  questKey: string;
  localDate: string;
  progress: number;
  target: number;
  status: QuestProgressStatus;
  rewardedAt: Date | null;
  rewardedBy: Types.ObjectId | null;
  rewardIntent: RewardIntent | null;
  rewardCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const progressSchema = new Schema<QuestProgressDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    questKey: { type: String, required: true },
    localDate: { type: String, required: true },
    progress: { type: Number, default: 0 },
    target: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['in_progress', 'completed', 'rewarded'], default: 'in_progress' },
    rewardedAt: { type: Date, default: null },
    rewardedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rewardIntent: { type: Schema.Types.Mixed, default: null },
    rewardCompletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

progressSchema.index({ coupleId: 1, questKey: 1, localDate: 1 }, { unique: true });

export const QuestProgress = model<QuestProgressDoc>('QuestProgress', progressSchema);
