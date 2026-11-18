import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import { Checkin, type CheckinDoc } from '../models/Checkin.js';
import { ECONOMY } from '../config/economy.js';
import type { CoupleDoc } from '../models/Couple.js';
import { checkinRepository } from '../repositories/checkin.repository.js';
import { walletService } from './wallet.service.js';
import { questService } from './quest.service.js';
import { addDays, getLocalDate, zonedTimeToUtc } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { rewardPolicyService } from './rewardPolicy.service.js';
import { dailyRewardService, type DailyActivityRewardView } from './dailyReward.service.js';

export interface CheckinView {
  localDate: string;
  reward: DailyActivityRewardView;
  streak: number;
  coinAwarded: number;
  expAwarded: number;
  balance: number | undefined;
  level: number | undefined;
  leveledUp: boolean;
}

export interface CheckinStatus {
  localDate: string;
  checkedInToday: boolean;
  reward: DailyActivityRewardView;
  streak: number;
  partnerCheckedIn: boolean;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

async function finishReward(couple: CoupleDoc, doc: CheckinDoc): Promise<CheckinView> {
  // Historical rows are not evidence that an old partial payment is safe to replay.
  if (doc.sourceValid === false) throw Errors.conflict('Ngày điểm danh đã đổi. Vui lòng tải lại.');
  if (!doc.rewardIntent) throw Errors.conflict('Bạn đã điểm danh hôm nay');
  const reward = await walletService.reward({ ...doc.rewardIntent, coupleId: couple._id, reason: 'checkin', refId: doc._id });
  await Checkin.updateOne({ _id: doc._id, rewardCompletedAt: null }, { $set: { rewardCompletedAt: new Date() } }).exec();
  try { await dailyRewardService.settleCheckins(couple, doc.localDate); }
  catch {
    // Source/individual EXP are already durable. The marker and wallet tombstone repair the pair reward.
    logger.warn('Check-in pair reward pending', { localDate: doc.localDate });
  }
  const daily = await dailyRewardService.getCheckinRewardView(couple, doc.localDate, String(doc.userId));
  await questService.refresh(couple, 'daily_checkin', doc.localDate);
  return { localDate: doc.localDate, reward: daily, streak: doc.streak,
    coinAwarded: daily.policyVersion === 2 ? daily.coinAwarded : doc.coinAwarded, expAwarded: doc.expAwarded,
    // The individual EXP receipt precedes pair settlement; do not return its stale balance on v2 days.
    balance: daily.policyVersion === 2 ? undefined : reward.coin, level: reward.level, leveledUp: reward.leveledUp ?? false };
}

export const checkinService = {
  async status(couple: CoupleDoc, userId: string): Promise<CheckinStatus> {
    const activePolicy = await rewardPolicyService.ensure(couple);
    const localDate = getLocalDate(new Date(), activePolicy.timezone);
    const uid = new Types.ObjectId(userId);
    await dailyRewardService.recoverCouple(couple);
    const rows = await checkinRepository.findForCoupleDate(couple._id, localDate);
    const mine = rows.find((r) => r.userId.equals(uid));
    if (mine?.rewardIntent && !mine.rewardCompletedAt) await finishReward(couple, mine);
    const latest = mine ?? (await checkinRepository.findLatest(couple._id, uid));
    const streak = latest && (latest.localDate === localDate || latest.localDate === addDays(localDate, -1)) ? latest.streak : 0;
    return {
      localDate,
      checkedInToday: Boolean(mine),
      reward: await dailyRewardService.getCheckinRewardView(couple, localDate, userId),
      streak,
      partnerCheckedIn: rows.some((r) => !r.userId.equals(uid)),
    };
  },

  async checkin(couple: CoupleDoc, userId: string): Promise<CheckinView> {
    const activePolicy = await rewardPolicyService.ensure(couple);
    const localDate = getLocalDate(new Date(), activePolicy.timezone);
    const uid = new Types.ObjectId(userId);

    const existing = await checkinRepository.findByDate(couple._id, uid, localDate);
    if (existing && existing.sourceValid !== false) return finishReward(couple, existing);

    const latest = await checkinRepository.findLatest(couple._id, uid);
    const streak = latest && latest.localDate === addDays(localDate, -1) ? latest.streak + 1 : 1;

    const policy = await rewardPolicyService.forDay(couple, localDate);
    const cfg = ECONOMY.checkin;
    const bonus = Math.min(cfg.streakBonusPerDay * (streak - 1), cfg.streakCap);
    const coin = policy.version === 2 ? 0 : cfg.coin + bonus;
    const exp = cfg.exp;

    let doc;
    try {
      doc = await checkinRepository.create({ coupleId: couple._id, userId: uid, localDate, streak, coinAwarded: coin, expAwarded: exp,
        dailySettlementPending: policy.version === 2,
        ...(policy.version === 2 ? { dayOpensAt: zonedTimeToUtc(localDate, '00:00', policy.timezone),
          dayClosesAt: zonedTimeToUtc(addDays(localDate, 1), '00:00', policy.timezone) } : {}),
        rewardIntent: { operationId: `checkin:${userId}:${localDate}`, actorUserId: userId, ownerUserId: userId, coin, exp,
          ...(policy.version === 2 ? { allocations: { [userId]: 0 }, provenance: { version: 1 as const, source: 'checkin' as const,
            localDate, policyVersion: 2 as const, component: 'checkin_exp' as const, baseCoin: 0, bonusCoin: 0 } } : {}) } });
    } catch (err) {
      // Unique index guards against double-award under concurrent taps.
      if (isDuplicateKey(err)) {
        const winner = await checkinRepository.findByDate(couple._id, uid, localDate);
        if (winner) return finishReward(couple, winner);
      }
      throw err;
    }

    await realtimeAudience.couple(couple._id, ['quests', 'couple']);
    logger.info('Check-in recorded', { coupleId: couple._id.toString(), userId, localDate, streak, coin, exp });
    return finishReward(couple, doc);
  },
};
