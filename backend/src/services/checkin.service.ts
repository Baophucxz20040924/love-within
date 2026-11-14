import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import { ECONOMY } from '../config/economy.js';
import type { CoupleDoc } from '../models/Couple.js';
import { checkinRepository } from '../repositories/checkin.repository.js';
import { walletService } from './wallet.service.js';
import { questService } from './quest.service.js';
import { addDays, getLocalDate } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface CheckinView {
  localDate: string;
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
  streak: number;
  partnerCheckedIn: boolean;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const checkinService = {
  async status(couple: CoupleDoc, userId: string): Promise<CheckinStatus> {
    const localDate = getLocalDate(new Date(), couple.timezone);
    const uid = new Types.ObjectId(userId);
    const rows = await checkinRepository.findForCoupleDate(couple._id, localDate);
    const mine = rows.find((r) => r.userId.equals(uid));
    const latest = mine ?? (await checkinRepository.findLatest(couple._id, uid));
    const streak = latest && (latest.localDate === localDate || latest.localDate === addDays(localDate, -1)) ? latest.streak : 0;
    return {
      localDate,
      checkedInToday: Boolean(mine),
      streak,
      partnerCheckedIn: rows.some((r) => !r.userId.equals(uid)),
    };
  },

  async checkin(couple: CoupleDoc, userId: string): Promise<CheckinView> {
    const localDate = getLocalDate(new Date(), couple.timezone);
    const uid = new Types.ObjectId(userId);

    const existing = await checkinRepository.findByDate(couple._id, uid, localDate);
    if (existing) throw Errors.conflict('Bạn đã điểm danh hôm nay');

    const latest = await checkinRepository.findLatest(couple._id, uid);
    const streak = latest && latest.localDate === addDays(localDate, -1) ? latest.streak + 1 : 1;

    const cfg = ECONOMY.checkin;
    const bonus = Math.min(cfg.streakBonusPerDay * (streak - 1), cfg.streakCap);
    const coin = cfg.coin + bonus;
    const exp = cfg.exp;

    let doc;
    try {
      doc = await checkinRepository.create({ coupleId: couple._id, userId: uid, localDate, streak, coinAwarded: coin, expAwarded: exp });
    } catch (err) {
      // Unique index guards against double-award under concurrent taps.
      if (isDuplicateKey(err)) throw Errors.conflict('Bạn đã điểm danh hôm nay');
      throw err;
    }

    await realtimeAudience.couple(couple._id, ['quests', 'couple']);
    const reward = await walletService.reward({ coupleId: couple._id, actorUserId: userId, reason: 'checkin', refId: doc._id, coin, exp });
    await questService.refresh(couple, 'daily_checkin', localDate);

    logger.info('Check-in recorded', { coupleId: couple._id.toString(), userId, localDate, streak, coin, exp });
    return {
      localDate,
      streak,
      coinAwarded: coin,
      expAwarded: exp,
      balance: reward.coin,
      level: reward.level,
      leveledUp: reward.leveledUp ?? false,
    };
  },
};
