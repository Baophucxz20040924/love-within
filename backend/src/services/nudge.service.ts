import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import { MAX_NUDGES_PER_DAY, NUDGE_COOLDOWN_SEC, type NudgeKind } from '../models/CoupleNudge.js';
import { nudgeRepository } from '../repositories/nudge.repository.js';
import { notificationService } from './notification.service.js';
import { addDays, getLocalDate, zonedTimeToUtc } from '../utils/date.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// "Nhớ bạn" một chạm (plan/ENGINEERING_WORKFLOW.md, CP5). The server enforces the wait between two nudges of one person
// (30 s) and the daily cap (50, couple timezone); the client only mirrors them. A nudge is pushed to the partner
// (group couple.nudges, urgency high, tag "nudge": the day's nudges collapse into one notification on the phone).

export interface NudgeSent {
  id: string;
  kind: NudgeKind;
  createdAt: string;
  /** My nudges to the partner today, this one included. */
  sentToday: number;
  remainingToday: number;
  /** When the next nudge is allowed (createdAt + 30 s). */
  nextAt: string;
}

/** Home pulse: nudges the caller received today (couple timezone). */
export interface PulseNudges {
  receivedToday: number;
  lastAt: string | null;
  lastKind: NudgeKind | null;
}

const EMOJI: Record<NudgeKind, string> = { miss: '💗', hug: '🤗', kiss: '😘', thinking: '💭' };

/** Push text of the first nudge of the day; later ones say how many there were today. */
const FIRST_BODY: Record<NudgeKind, (name: string) => string> = {
  miss: (name) => `${name} đang nhớ bạn 💗`,
  hug: (name) => `${name} gửi bạn một cái ôm 🤗`,
  kiss: (name) => `${name} gửi bạn một nụ hôn 😘`,
  thinking: (name) => `${name} đang nghĩ về bạn 💭`,
};

export function nudgePushBody(kind: NudgeKind, countToday: number): (name: string) => string {
  return countToday <= 1 ? FIRST_BODY[kind] : (name) => `${name} đã nhớ bạn ${countToday} lần hôm nay ${EMOJI[kind]}`;
}

/** Start of the couple's day (00:00 couple time) as a UTC instant, and the start of the next one. */
function dayBounds(couple: CoupleDoc, now: Date): { start: Date; next: Date } {
  const today = getLocalDate(now, couple.timezone);
  return { start: zonedTimeToUtc(today, '00:00', couple.timezone), next: zonedTimeToUtc(addDays(today, 1), '00:00', couple.timezone) };
}

const tooSoon = (sec: number) =>
  new AppError(429, 'NUDGE_TOO_SOON', `Bạn vừa gửi rồi. Chờ ${sec} giây nữa nhé.`, { retryAfter: sec });
const dailyLimit = (sec: number) =>
  new AppError(429, 'NUDGE_DAILY_LIMIT', `Hôm nay bạn đã gửi ${MAX_NUDGES_PER_DAY} lần rồi. Mai gửi tiếp nhé!`, { retryAfter: sec });

export const nudgeService = {
  async send(couple: CoupleDoc, userId: string, kind: NudgeKind): Promise<NudgeSent> {
    const me = new Types.ObjectId(userId);
    const partner = couple.memberIds.find((m) => !m.equals(me));
    if (!partner) throw new AppError(409, 'NO_PARTNER', 'Couple chưa đủ hai người');
    const pair = { coupleId: couple._id, fromUserId: me, toUserId: partner };
    const now = new Date();
    const { start, next } = dayBounds(couple, now);
    const untilTomorrow = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));

    const last = await nudgeRepository.lastSent(pair);
    if (last) {
      const waitMs = NUDGE_COOLDOWN_SEC * 1000 - (now.getTime() - last.createdAt.getTime());
      if (waitMs > 0) throw tooSoon(Math.ceil(waitMs / 1000));
    }
    if ((await nudgeRepository.countSentSince(pair, start)) >= MAX_NUDGES_PER_DAY) throw dailyLimit(untilTomorrow);

    const doc = await nudgeRepository.create({ ...pair, kind });
    // Two taps at once both pass the checks above. The earliest row (createdAt, then _id) wins; the others remove
    // themselves, so the 30 s gap and the daily cap hold without a lock.
    const [closer, earlierToday] = await Promise.all([
      nudgeRepository.countBefore(pair, doc, new Date(doc.createdAt.getTime() - NUDGE_COOLDOWN_SEC * 1000), false),
      nudgeRepository.countBefore(pair, doc, start, true),
    ]);
    if (closer > 0 || earlierToday >= MAX_NUDGES_PER_DAY) {
      await nudgeRepository.deleteById(couple._id, doc._id);
      throw closer > 0 ? tooSoon(NUDGE_COOLDOWN_SEC) : dailyLimit(untilTomorrow);
    }

    await realtimeAudience.couple(couple._id, ['couple']);
    const sentToday = earlierToday + 1;
    await notificationService.toPartner(couple, me, {
      type: 'nudge',
      entityId: doc._id,
      push: { body: nudgePushBody(kind, sentToday), url: '/', tag: 'nudge' },
    });
    logger.debug('Nudge sent', { coupleId: couple._id.toString(), userId, kind, sentToday });
    return {
      id: doc._id.toString(),
      kind,
      createdAt: doc.createdAt.toISOString(),
      sentToday,
      remainingToday: MAX_NUDGES_PER_DAY - sentToday,
      nextAt: new Date(doc.createdAt.getTime() + NUDGE_COOLDOWN_SEC * 1000).toISOString(),
    };
  },

  /** Home pulse: how many nudges I received today and the latest one. */
  async pulse(couple: CoupleDoc, userId: string): Promise<PulseNudges> {
    const me = new Types.ObjectId(userId);
    const { start } = dayBounds(couple, new Date());
    const [receivedToday, last] = await Promise.all([
      nudgeRepository.countReceivedSince(couple._id, me, start),
      nudgeRepository.lastReceivedSince(couple._id, me, start),
    ]);
    return { receivedToday, lastAt: last ? last.createdAt.toISOString() : null, lastKind: last ? last.kind : null };
  },
};
