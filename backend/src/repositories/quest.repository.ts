import type { Types } from 'mongoose';
import { Quest, QuestProgress, type QuestDoc, type QuestProgressDoc } from '../models/Quest.js';

export const questRepository = {
  listActive(): Promise<QuestDoc[]> {
    return Quest.find({ active: true }).exec();
  },

  findByKey(key: string): Promise<QuestDoc | null> {
    return Quest.findOne({ key }).exec();
  },

  async upsertDefinition(def: {
    key: string;
    title: string;
    description: string;
    type: QuestDoc['type'];
    coinReward: number;
    expReward: number;
  }): Promise<void> {
    await Quest.updateOne({ key: def.key }, { $set: def, $setOnInsert: { active: true } }, { upsert: true }).exec();
  },

  /** Ensure a progress row exists for (couple, quest, day). Idempotent via unique index. */
  async ensureProgress(coupleId: Types.ObjectId, questKey: string, localDate: string, target: number): Promise<QuestProgressDoc> {
    return QuestProgress.findOneAndUpdate(
      { coupleId, questKey, localDate },
      { $setOnInsert: { coupleId, questKey, localDate, target, progress: 0, status: 'in_progress' } },
      { new: true, upsert: true },
    ).exec();
  },

  listForDate(coupleId: Types.ObjectId, localDate: string): Promise<QuestProgressDoc[]> {
    return QuestProgress.find({ coupleId, localDate }).exec();
  },

  findOne(coupleId: Types.ObjectId, questKey: string, localDate: string): Promise<QuestProgressDoc | null> {
    return QuestProgress.findOne({ coupleId, questKey, localDate }).exec();
  },

  /** Set progress + target; promotes to completed when progress >= target (never demotes rewarded). */
  async setProgress(coupleId: Types.ObjectId, questKey: string, localDate: string, progress: number, target: number): Promise<QuestProgressDoc | null> {
    const status = progress >= target ? 'completed' : 'in_progress';
    return QuestProgress.findOneAndUpdate(
      { coupleId, questKey, localDate, status: { $ne: 'rewarded' } },
      { $set: { progress, target, status } },
      { new: true },
    ).exec();
  },

  /** Atomically transition completed → rewarded. Returns null if not claimable (anti double-claim). */
  markRewarded(coupleId: Types.ObjectId, questKey: string, localDate: string, userId: Types.ObjectId): Promise<QuestProgressDoc | null> {
    return QuestProgress.findOneAndUpdate(
      { coupleId, questKey, localDate, status: 'completed' },
      { $set: { status: 'rewarded', rewardedAt: new Date(), rewardedBy: userId } },
      { new: true },
    ).exec();
  },
};
