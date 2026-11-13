import { Types } from 'mongoose';
import { ECONOMY } from '../config/economy.js';
import type { CoupleDoc } from '../models/Couple.js';
import type { QuestDoc, QuestProgressDoc, QuestProgressStatus, QuestType } from '../models/Quest.js';
import { questRepository } from '../repositories/quest.repository.js';
import { checkinRepository } from '../repositories/checkin.repository.js';
import { coupleSettingsRepository } from '../repositories/coupleSettings.repository.js';
import { answerRepository, questionRepository } from '../repositories/question.repository.js';
import { momentRepository } from '../repositories/moment.repository.js';
import { WaterDaily } from '../models/WaterDaily.js';
import { walletService } from './wallet.service.js';
import { getLocalDate } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * A resolver computes the (progress, target) of one quest TYPE for a couple on a day.
 * Returning null means the quest is not available (e.g. no water goal agreed yet).
 * New quest types = add a resolver here + a Quest definition; the core stays untouched.
 */
interface QuestResolver {
  resolve(couple: CoupleDoc, localDate: string): Promise<{ progress: number; target: number } | null>;
}

const resolvers: Record<QuestType, QuestResolver> = {
  // Both members check in today.
  checkin: {
    async resolve(couple, localDate) {
      const rows = await checkinRepository.findForCoupleDate(couple._id, localDate);
      return { progress: rows.length, target: couple.memberIds.length };
    },
  },
  // Per-user goal: the quest completes when at least one member reaches the agreed goal.
  // Progress shown is the highest member total so "1200/2000 ml" reads naturally.
  water_goal: {
    async resolve(couple, localDate) {
      const settings = await coupleSettingsRepository.getOrCreate(couple._id);
      if (!settings.waterGoalMl) return null;
      const rows = await WaterDaily.find({ coupleId: couple._id, localDate }).exec();
      const best = rows.reduce((m, r) => Math.max(m, r.totalMl), 0);
      return { progress: Math.min(best, settings.waterGoalMl), target: settings.waterGoalMl };
    },
  },
  // Manually completed quests: progress is driven by explicit completion calls (future).
  custom_boolean: {
    async resolve() {
      return { progress: 0, target: 1 };
    },
  },
  // CP1: members who answered TODAY's question during the day. Late answers to earlier days never count.
  daily_question: {
    async resolve(couple, localDate) {
      const target = couple.memberIds.length;
      const q = await questionRepository.findByDate(couple._id, localDate);
      if (!q) return { progress: 0, target };
      const answers = await answerRepository.listFor(couple._id, [q._id]);
      const onTime = answers.filter((a) => getLocalDate(a.createdAt, couple.timezone) === localDate).length;
      return { progress: Math.min(onTime, target), target };
    },
  },
  // CP6: photos posted to the day's duo moment (one per member, on time or late; posting closes at the end of the day).
  duo_moment: {
    async resolve(couple, localDate) {
      const target = couple.memberIds.length;
      const m = await momentRepository.findDay(couple._id, localDate);
      return { progress: Math.min(m?.posts.length ?? 0, target), target };
    },
  },
};

/** Quest key of "Câu hỏi mỗi ngày" (refreshed by questionService when today's question is answered). */
export const DAILY_QUESTION_QUEST_KEY = 'daily_question';
/** Quest key of "Khoảnh khắc đôi" (refreshed by momentService when a photo is posted). */
export const DUO_MOMENT_QUEST_KEY = 'duo_moment';

export const DEFAULT_QUESTS = [
  {
    key: 'daily_checkin',
    title: 'Cùng điểm danh',
    description: 'Cả hai cùng điểm danh hôm nay.',
    type: 'checkin' as QuestType,
    coinReward: ECONOMY.quests.daily_checkin.coin,
    expReward: ECONOMY.quests.daily_checkin.exp,
  },
  {
    key: 'drink_water',
    title: 'Uống đủ nước',
    description: 'Đạt mục tiêu nước trong ngày.',
    type: 'water_goal' as QuestType,
    coinReward: ECONOMY.quests.drink_water.coin,
    expReward: ECONOMY.quests.drink_water.exp,
  },
  {
    key: DAILY_QUESTION_QUEST_KEY,
    title: 'Câu hỏi mỗi ngày',
    description: 'Cả hai trả lời câu hỏi hôm nay.',
    type: 'daily_question' as QuestType,
    coinReward: ECONOMY.quests.daily_question.coin,
    expReward: ECONOMY.quests.daily_question.exp,
  },
  {
    key: DUO_MOMENT_QUEST_KEY,
    title: 'Khoảnh khắc đôi',
    description: 'Cả hai cùng chụp Khoảnh khắc hôm nay.',
    type: 'duo_moment' as QuestType,
    coinReward: ECONOMY.quests.duo_moment.coin,
    expReward: ECONOMY.quests.duo_moment.exp,
  },
];

export interface QuestView {
  key: string;
  title: string;
  description: string;
  type: QuestType;
  coinReward: number;
  expReward: number;
  progress: number;
  target: number;
  status: QuestProgressStatus;
  localDate: string;
}

function rewardFor(q: QuestDoc): { coin: number; exp: number } {
  return ECONOMY.quests[q.key] ?? { coin: q.coinReward, exp: q.expReward };
}

function toView(q: QuestDoc, p: QuestProgressDoc): QuestView {
  const r = rewardFor(q);
  return {
    key: q.key,
    title: q.title,
    description: q.description,
    type: q.type,
    coinReward: r.coin,
    expReward: r.exp,
    progress: p.progress,
    target: p.target,
    status: p.status,
    localDate: p.localDate,
  };
}

export const questService = {
  /** Upsert the default quest catalog. Safe to run at every startup. */
  async seedDefaults(): Promise<void> {
    for (const def of DEFAULT_QUESTS) await questRepository.upsertDefinition(def);
  },

  /** Initialize (if needed) and refresh today's quests for the couple. */
  async getToday(couple: CoupleDoc): Promise<QuestView[]> {
    const localDate = getLocalDate(new Date(), couple.timezone);
    const quests = await questRepository.listActive();
    // Quests are independent (different progress rows), so resolve them in parallel; order is kept.
    const views = await Promise.all(
      quests.map(async (q) => {
        const resolved = await resolvers[q.type].resolve(couple, localDate);
        if (!resolved) return null;
        await questRepository.ensureProgress(couple._id, q.key, localDate, resolved.target);
        const updated =
          (await questRepository.setProgress(couple._id, q.key, localDate, resolved.progress, resolved.target)) ??
          (await questRepository.findOne(couple._id, q.key, localDate));
        return updated ? toView(q, updated) : null;
      }),
    );
    return views.filter((v): v is QuestView => v !== null);
  },

  /** Recompute one quest's progress (called by check-in and water services after changes). */
  async refresh(couple: CoupleDoc, questKey: string, localDate: string): Promise<void> {
    const q = await questRepository.findByKey(questKey);
    if (!q || !q.active) return;
    const resolved = await resolvers[q.type].resolve(couple, localDate);
    if (!resolved) return;
    await questRepository.ensureProgress(couple._id, q.key, localDate, resolved.target);
    await questRepository.setProgress(couple._id, q.key, localDate, resolved.progress, resolved.target);
  },

  /** Claim the reward of a completed quest exactly once (atomic status transition). */
  async claim(couple: CoupleDoc, userId: string, questKey: string): Promise<QuestView> {
    const localDate = getLocalDate(new Date(), couple.timezone);
    const q = await questRepository.findByKey(questKey);
    if (!q || !q.active) throw Errors.notFound('Nhiệm vụ không tồn tại');

    // Make sure progress is current before judging completion.
    await questService.refresh(couple, questKey, localDate);
    const current = await questRepository.findOne(couple._id, questKey, localDate);
    if (!current) throw Errors.notFound('Nhiệm vụ chưa khả dụng hôm nay');
    if (current.status === 'rewarded') throw Errors.conflict('Nhiệm vụ đã nhận thưởng hôm nay');
    if (current.status !== 'completed') throw Errors.conflict('Nhiệm vụ chưa hoàn thành');

    const rewarded = await questRepository.markRewarded(couple._id, questKey, localDate, new Types.ObjectId(userId));
    if (!rewarded) throw Errors.conflict('Nhiệm vụ đã nhận thưởng hôm nay');

    const r = rewardFor(q);
    await walletService.reward({ coupleId: couple._id, actorUserId: userId, reason: 'quest', refId: rewarded._id, coin: r.coin, exp: r.exp });
    logger.info('Quest reward claimed', { coupleId: couple._id.toString(), userId, questKey, localDate });
    return toView(q, rewarded);
  },
};
