import type { Types } from 'mongoose';
import { DailyRewardSettlement, type DailyRewardComponent, type DailyRewardSettlementDoc } from '../models/DailyRewardSettlement.js';
import { Checkin } from '../models/Checkin.js';
import { DuoMoment } from '../models/DuoMoment.js';
import { QuestProgress } from '../models/Quest.js';
import { duplicateKey } from './wallet.repository.js';

type NewSettlement = Pick<DailyRewardSettlementDoc, 'coupleId' | 'localDate' | 'component' | 'beneficiary' | 'memberIds' | 'commonStreak' | 'baseCoin' | 'bonusCoin' | 'intent'>;
export const dailyRewardRepository = {
  find(coupleId: Types.ObjectId, localDate: string, component: DailyRewardComponent, beneficiary = 'pair') {
    return DailyRewardSettlement.findOne({ coupleId, localDate, component, beneficiary }).exec();
  },
  listDay(coupleId: Types.ObjectId, localDate: string) { return DailyRewardSettlement.find({ coupleId, localDate }).exec(); },
  listDays(coupleId: Types.ObjectId, localDates: string[]) {
    return DailyRewardSettlement.find({ coupleId, localDate: { $in: localDates } }).lean().exec();
  },
  frozenMomentQuests(coupleId: Types.ObjectId, localDates: string[]) {
    return QuestProgress.find({ coupleId, questKey: 'duo_moment', localDate: { $in: localDates }, $or: [{ rewardIntent: { $ne: null } }, { status: 'rewarded' }] })
      .select({ localDate: 1, rewardIntent: 1, status: 1 }).lean().exec();
  },
  async ensure(input: NewSettlement): Promise<DailyRewardSettlementDoc> {
    const key = { coupleId: input.coupleId, localDate: input.localDate, component: input.component, beneficiary: input.beneficiary };
    try {
      return await DailyRewardSettlement.findOneAndUpdate(key, { $setOnInsert: input }, { new: true, upsert: true }).orFail().exec();
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      return DailyRewardSettlement.findOne(key).orFail().exec();
    }
  },
  async complete(id: Types.ObjectId) {
    await DailyRewardSettlement.updateOne({ _id: id, completedAt: null }, { $set: { completedAt: new Date() } }).exec();
  },
  pending(coupleId: Types.ObjectId, limit: number) {
    return DailyRewardSettlement.find({ coupleId, completedAt: null }).sort({ localDate: 1 }).limit(limit).exec();
  },
  pendingCheckins(coupleId: Types.ObjectId, limit: number) {
    return Checkin.find({ coupleId, dailySettlementPending: true }).sort({ localDate: 1, _id: 1 }).limit(limit).exec();
  },
  async clearCheckins(ids: Types.ObjectId[]) {
    // Clear only the snapshots inspected. A concurrently inserted partner retains its own flag.
    await Checkin.updateMany({ _id: { $in: ids } }, { $set: { dailySettlementPending: false } }).exec();
  },
  pendingMoments(coupleId: Types.ObjectId, limit: number) {
    return DuoMoment.find({ coupleId, rewardSettlementPending: true }).sort({ localDate: 1 }).limit(limit).exec();
  },
  async clearMoment(day: import('../models/DuoMoment.js').DuoMomentDoc) {
    // updatedAt alone can collide within a millisecond. Exact post arrays fence a concurrent partner commit.
    const postSnapshot = Object.fromEntries((day.sessions ?? []).map((session, index) => [`sessions.${index}.posts`, session.posts]));
    await DuoMoment.updateOne({ _id: day._id, updatedAt: day.updatedAt, ...postSnapshot }, { $set: { rewardSettlementPending: false } }, { timestamps: false }).exec();
  },
  frozenQuest(coupleId: Types.ObjectId, questKey: string, localDate: string) {
    return QuestProgress.findOne({ coupleId, questKey, localDate, $or: [{ rewardIntent: { $ne: null } }, { status: 'rewarded' }] }).exec();
  },
};
