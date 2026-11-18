import type { Types } from 'mongoose';
import { Couple, type CoupleDoc } from '../models/Couple.js';
import { newDailyRewardPolicy } from '../services/rewardPolicy.service.js';

export const coupleRepository = {
  findById(id: Types.ObjectId): Promise<CoupleDoc | null> {
    return Couple.findById(id).exec();
  },

  findActiveById(id: Types.ObjectId): Promise<CoupleDoc | null> {
    return Couple.findOne({ _id: id, status: 'active' }).exec();
  },

  create(input: { memberIds: Types.ObjectId[]; timezone: string }): Promise<CoupleDoc> {
    return Couple.create({ ...input, anniversaryDate: new Date(), dailyRewardPolicy: newDailyRewardPolicy(input.timezone) });
  },

  async archive(id: Types.ObjectId): Promise<void> {
    await Couple.updateOne({ _id: id }, { $set: { status: 'archived' } }).exec();
  },

  async setAnniversaryDate(id: Types.ObjectId, date: Date): Promise<void> {
    await Couple.updateOne({ _id: id }, { $set: { anniversaryDate: date } }).exec();
  },

  /** Atomically add EXP and return the updated doc (level is recomputed by caller). */
  incExp(id: Types.ObjectId, delta: number): Promise<CoupleDoc | null> {
    return Couple.findOneAndUpdate({ _id: id }, { $inc: { exp: delta } }, { new: true }).exec();
  },

  async setLevel(id: Types.ObjectId, level: number): Promise<void> {
    await Couple.updateOne({ _id: id }, { $set: { level } }).exec();
  },

  /** Background jobs (N2): active couples in _id order, one page at a time (`after` = last _id of the previous page). */
  listActivePage(after: Types.ObjectId | null, limit: number): Promise<CoupleDoc[]> {
    return Couple.find({ status: 'active', ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 })
      .limit(limit)
      .exec();
  },
};
