import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import type { CoupleMoodDoc, Mood } from '../models/CoupleMood.js';
import { moodRepository } from '../repositories/nudge.repository.js';
import { addDays, getLocalDate } from '../utils/date.js';
import { logger } from '../utils/logger.js';

// "Cảm xúc hôm nay" (plan/ENGINEERING_WORKFLOW.md, CP5): one mood per member per day (couple timezone), last write wins.
// Both members see each other's mood and note; the note is never logged. Changing a mood does not push.

export interface MoodView {
  userId: string;
  /** "YYYY-MM-DD", couple timezone. */
  localDate: string;
  mood: Mood;
  note: string;
  /** Last change ("Hà: 😴 mệt mỏi · 2 giờ trước"). */
  updatedAt: string;
}

export interface MoodHistory {
  days: number;
  /** First and last day of the window ("YYYY-MM-DD"); `to` is today. */
  from: string;
  to: string;
  /** Both members, oldest day first. */
  items: MoodView[];
}

export interface PulseMoods {
  mine: MoodView | null;
  partner: MoodView | null;
}

function toView(m: CoupleMoodDoc): MoodView {
  return { userId: m.userId.toString(), localDate: m.localDate, mood: m.mood, note: m.note, updatedAt: m.updatedAt.toISOString() };
}

const todayOf = (couple: CoupleDoc) => getLocalDate(new Date(), couple.timezone);

export const moodService = {
  async setToday(couple: CoupleDoc, userId: string, input: { mood: Mood; note: string }): Promise<MoodView> {
    const localDate = todayOf(couple);
    const doc = await moodRepository.upsertDay({
      coupleId: couple._id,
      userId: new Types.ObjectId(userId),
      localDate,
      mood: input.mood,
      note: input.note.trim(),
    });
    logger.debug('Mood set', { coupleId: couple._id.toString(), userId, localDate });
    return toView(doc);
  },

  /** The last `days` days (today included) of both members. */
  async history(couple: CoupleDoc, days: number): Promise<MoodHistory> {
    const to = todayOf(couple);
    const from = addDays(to, -(days - 1));
    const rows = await moodRepository.listRange(couple._id, couple.memberIds, from, to);
    return { days, from, to, items: rows.map(toView) };
  },

  /** Home pulse: today's mood of me and of my partner. */
  async pulse(couple: CoupleDoc, userId: string): Promise<PulseMoods> {
    const rows = await moodRepository.listDay(couple._id, couple.memberIds, todayOf(couple));
    const mine = rows.find((r) => r.userId.toString() === userId);
    const partner = rows.find((r) => r.userId.toString() !== userId);
    return { mine: mine ? toView(mine) : null, partner: partner ? toView(partner) : null };
  },
};
