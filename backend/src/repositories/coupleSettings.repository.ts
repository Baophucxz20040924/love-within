import type { Types } from 'mongoose';
import { CoupleSettings, type CoupleSettingsDoc } from '../models/CoupleSettings.js';

export const coupleSettingsRepository = {
  getOrCreate(coupleId: Types.ObjectId): Promise<CoupleSettingsDoc> {
    return CoupleSettings.findOneAndUpdate(
      { coupleId },
      { $setOnInsert: { coupleId, waterGoalMl: null, waterGoalScope: 'per_user' } },
      { new: true, upsert: true },
    ).exec();
  },

  async setWaterGoal(coupleId: Types.ObjectId, goalMl: number): Promise<void> {
    await CoupleSettings.updateOne(
      { coupleId },
      { $set: { waterGoalMl: goalMl }, $setOnInsert: { waterGoalScope: 'per_user' } },
      { upsert: true },
    ).exec();
  },
};
