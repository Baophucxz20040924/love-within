import { randomInt, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { CoupleDoc } from '../models/Couple.js';
import {
  MOMENT_ON_TIME_MIN,
  MOMENT_WINDOW_FROM,
  MOMENT_WINDOW_TO,
  type DuoMomentDoc,
  type MomentPost,
} from '../models/DuoMoment.js';
import { getStorage } from '../integrations/index.js';
import { momentRepository, type NewMomentDay } from '../repositories/moment.repository.js';
import { storyRepository } from '../repositories/story.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { notificationService } from './notification.service.js';
import { DUO_MOMENT_QUEST_KEY, questService } from './quest.service.js';
import { STORY_IMAGE_TYPES, storyService, type StoryView } from './story.service.js';
import { addDays, formatDayVi, getLocalDate, zonedTimeToUtc } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// "Khoảnh khắc đôi" (plan/COUPLE_V2_PLAN.md, CP6; owner decision 7). Privacy rules, enforced here and nowhere else:
// - promptAt (and windowEndsAt) are never returned before the prompt time has passed (server clock);
// - the partner's photo (presigned URL) and caption are only returned to a member who has posted that day;
// - object keys are never returned (the uploader gets its own key from upload-url only).
// Captions are never logged.

const MIN_MS = 60_000;
/** Days read for the streak (the whole history of nearly any couple; only localDate is read). */
const STREAK_LOOKBACK = 1000;

export type MomentState = 'waiting' | 'open' | 'posted' | 'both' | 'missed';

export interface MomentPhotoView {
  url: string;
  width: number;
  height: number;
  caption: string;
  postedAt: string;
  /** 0 = on time (within 10 minutes of the prompt). */
  lateMin: number;
}

export interface MomentDayView {
  localDate: string;
  /** From the caller's side: waiting (before the prompt), open (I can post), posted (I did, partner not yet), both, missed (day over, I did not post). */
  state: MomentState;
  /** Only once the prompt time has passed. */
  promptAt: string | null;
  /** promptAt + 10 minutes ("on time" until then); only once the prompt time has passed. */
  windowEndsAt: string | null;
  /** Posting is possible until this instant (00:00 of the next day, couple timezone): "tới 23:59". */
  closesAt: string;
  /** The day is over (no more posts). */
  closed: boolean;
  mine: MomentPhotoView | null;
  /** `photo` (with the caption) only when I have posted that day. */
  partner: { posted: boolean; postedAt: string | null; photo: MomentPhotoView | null };
  /** The Story post made from both photos; null when none was made or it has been deleted. */
  storyId: string | null;
}

export interface MomentMonthView {
  month: string;
  today: string;
  /** Earliest month with possible moments (the couple's first month), for the month picker. */
  minMonth: string;
  /** Only days that have a moment, oldest first. */
  days: MomentDayView[];
  /** Days in a row (ending today, or yesterday while today is not done yet) on which both posted; best run ever. */
  streak: { current: number; best: number };
}

/** GET /api/couple/pulse → moment (Home card "Khoảnh khắc đang mở" while state is open). */
export interface PulseMoment {
  state: MomentState;
  windowEndsAt: string | null;
  /** Extra field (not in the plan): the Home card says "Hà đã chụp 🔒" without a second request. */
  partnerPosted: boolean;
}

export interface MomentPostInput {
  key: string;
  width: number;
  height: number;
  caption: string;
}

const notYet = () => new AppError(409, 'MOMENT_NOT_YET', 'Hôm nay chưa tới giờ Khoảnh khắc. Khi tới giờ, app sẽ báo bạn.');
const alreadyPosted = () => new AppError(409, 'MOMENT_ALREADY_POSTED', 'Hôm nay bạn đã chụp Khoảnh khắc rồi.');

function momentPrefix(coupleId: Types.ObjectId): string {
  return `couples/${coupleId.toString()}/moments/`;
}

/** 00:00 of the next day, couple timezone: posts are accepted before it (the plan's "hạn chót 23:59"). */
export function closesAtOf(localDate: string, timezone: string): Date {
  return zonedTimeToUtc(addDays(localDate, 1), '00:00', timezone);
}

/**
 * The day's prompt time: a random whole minute (crypto RNG) in 09:00–21:00 couple time, never earlier than one minute
 * from now, so a day created late (new couple, server down in the morning) still gets a prompt that has not passed.
 * A day created after 21:00 gets 21:00 and counts as announced (no push for a prompt that is already over); its members
 * can still post until 23:59, as late posts.
 */
export function newMomentDay(coupleId: Types.ObjectId, localDate: string, timezone: string, now: Date): NewMomentDay {
  const from = zonedTimeToUtc(localDate, MOMENT_WINDOW_FROM, timezone).getTime();
  const to = zonedTimeToUtc(localDate, MOMENT_WINDOW_TO, timezone).getTime();
  const soonest = Math.ceil((now.getTime() + MIN_MS) / MIN_MS) * MIN_MS;
  const start = Math.max(from, soonest);
  if (start > to) return { coupleId, localDate, promptAt: new Date(to), notifiedAt: now };
  const minutes = Math.floor((to - start) / MIN_MS);
  return { coupleId, localDate, promptAt: new Date(start + randomInt(minutes + 1) * MIN_MS), notifiedAt: null };
}

function stateOf(m: DuoMomentDoc, userId: string, now: Date, closesAt: Date): MomentState {
  const mine = m.posts.some((p) => p.userId.toString() === userId);
  if (m.posts.length >= 2) return 'both';
  if (mine) return 'posted';
  if (now.getTime() >= closesAt.getTime()) return 'missed';
  if (now.getTime() < m.promptAt.getTime()) return 'waiting';
  return 'open';
}

async function photoView(p: MomentPost): Promise<MomentPhotoView> {
  return {
    url: (await getStorage().getDownloadUrl(p.key, { cacheable: true })).url,
    width: p.width,
    height: p.height,
    caption: p.caption,
    postedAt: p.postedAt.toISOString(),
    lateMin: p.lateMin,
  };
}

async function dayView(couple: CoupleDoc, m: DuoMomentDoc, userId: string, now: Date, storyAlive: boolean): Promise<MomentDayView> {
  const closesAt = closesAtOf(m.localDate, couple.timezone);
  const prompted = m.promptAt.getTime() <= now.getTime();
  const mine = m.posts.find((p) => p.userId.toString() === userId) ?? null;
  const partner = m.posts.find((p) => p.userId.toString() !== userId) ?? null;
  return {
    localDate: m.localDate,
    state: stateOf(m, userId, now, closesAt),
    promptAt: prompted ? m.promptAt.toISOString() : null,
    windowEndsAt: prompted ? new Date(m.promptAt.getTime() + MOMENT_ON_TIME_MIN * MIN_MS).toISOString() : null,
    closesAt: closesAt.toISOString(),
    closed: now.getTime() >= closesAt.getTime(),
    mine: mine ? await photoView(mine) : null,
    partner: {
      posted: partner !== null,
      postedAt: partner ? partner.postedAt.toISOString() : null,
      // Never the partner's photo or words before my own post (whatever the client asks for).
      photo: partner && mine ? await photoView(partner) : null,
    },
    storyId: m.storyId && storyAlive ? m.storyId.toString() : null,
  };
}

async function viewsOf(couple: CoupleDoc, docs: DuoMomentDoc[], userId: string, now: Date): Promise<MomentDayView[]> {
  const storyIds = docs.map((d) => d.storyId).filter((id): id is Types.ObjectId => id !== null && id !== undefined);
  const alive = await storyRepository.aliveIds(couple._id, storyIds);
  return Promise.all(docs.map((d) => dayView(couple, d, userId, now, d.storyId ? alive.has(d.storyId.toString()) : false)));
}

/** Today's moment, created on first use with the same random rule as the job (one moment per day: unique index). */
async function ensureToday(couple: CoupleDoc, now: Date): Promise<DuoMomentDoc> {
  const localDate = getLocalDate(now, couple.timezone);
  const existing = await momentRepository.findDay(couple._id, localDate);
  if (existing) return existing;
  const doc = await momentRepository.ensureDay(newMomentDay(couple._id, localDate, couple.timezone, now));
  logger.info('Duo moment day created', { coupleId: couple._id.toString(), localDate, by: 'request' });
  return doc;
}

function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || displayName;
}

/** Streak of days in a row on which both posted (newest-first list of such days). */
export function streakOf(bothDays: string[], today: string): { current: number; best: number } {
  const set = new Set(bothDays);
  let current = 0;
  let day = set.has(today) ? today : addDays(today, -1);
  while (set.has(day)) {
    current += 1;
    day = addDays(day, -1);
  }
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of bothDays) {
    run = prev !== null && addDays(prev, -1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best: Math.max(best, current) };
}

export const momentService = {
  async today(couple: CoupleDoc, userId: string): Promise<MomentDayView> {
    const now = new Date();
    const m = await ensureToday(couple, now);
    return (await viewsOf(couple, [m], userId, now))[0];
  },

  /** Calendar of one month ("YYYY-MM"), with the streak. */
  async month(couple: CoupleDoc, userId: string, month: string): Promise<MomentMonthView> {
    const now = new Date();
    const today = getLocalDate(now, couple.timezone);
    if (month === today.slice(0, 7)) await ensureToday(couple, now);
    const [docs, both] = await Promise.all([
      momentRepository.listRange(couple._id, `${month}-01`, `${month}-31`),
      momentRepository.bothDays(couple._id, STREAK_LOOKBACK),
    ]);
    return {
      month,
      today,
      minMonth: getLocalDate(couple.createdAt, couple.timezone).slice(0, 7),
      days: await viewsOf(couple, docs, userId, now),
      streak: streakOf(both, today),
    };
  },

  /** Presigned PUT for my photo of today: only after the prompt time and before I have posted. */
  async createUploadUrl(couple: CoupleDoc, userId: string, mimeType: string, sizeBytes: number) {
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const now = new Date();
    const m = await ensureToday(couple, now);
    if (now.getTime() < m.promptAt.getTime()) throw notYet();
    if (m.posts.some((p) => p.userId.toString() === userId)) throw alreadyPosted();
    const imageKey = `${momentPrefix(couple._id)}${m.localDate.slice(0, 7)}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  /** POST /api/moments/today: my one photo of the day (409 before the prompt or when already posted). */
  async post(couple: CoupleDoc, userId: string, input: MomentPostInput): Promise<MomentDayView> {
    const now = new Date();
    const m = await ensureToday(couple, now);
    const uid = new Types.ObjectId(userId);
    if (now.getTime() < m.promptAt.getTime()) throw notYet();
    if (m.posts.some((p) => p.userId.equals(uid))) throw alreadyPosted();

    // The photo must be this couple's moment upload and really exist in storage (same rule as stories).
    if (!input.key.startsWith(momentPrefix(couple._id)) || input.key.includes('..')) {
      logger.warn('Rejected foreign moment photo key', { coupleId: couple._id.toString(), userId, key: input.key });
      throw Errors.forbidden('Ảnh không thuộc couple của bạn');
    }
    if (m.posts.some((p) => p.key === input.key)) throw Errors.badRequest('Ảnh này đã được dùng');
    const head = await getStorage().headObject(input.key);
    if (!head) throw Errors.badRequest('Ảnh chưa tải lên xong. Thử đăng lại nhé.');
    if (head.size > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');

    const elapsedMin = Math.floor((now.getTime() - m.promptAt.getTime()) / MIN_MS);
    const post: MomentPost = {
      userId: uid,
      key: input.key,
      width: input.width,
      height: input.height,
      caption: input.caption.trim(),
      postedAt: now,
      lateMin: elapsedMin >= MOMENT_ON_TIME_MIN ? elapsedMin : 0,
    };
    const updated = await momentRepository.addPost(couple._id, m.localDate, post, now);
    if (!updated) {
      // A second tap of mine a moment ago (the condition is checked in the update itself).
      const current = await momentRepository.findDay(couple._id, m.localDate);
      if (current?.posts.some((p) => p.userId.equals(uid))) throw alreadyPosted();
      throw notYet();
    }

    const both = updated.posts.length >= 2;
    logger.info('Duo moment posted', { coupleId: couple._id.toString(), userId, localDate: m.localDate, lateMin: post.lateMin, both });
    await questService.refresh(couple, DUO_MOMENT_QUEST_KEY, m.localDate);
    // Never the photo or the caption on the lock screen.
    await notificationService.toPartner(couple, uid, {
      type: both ? 'moment_both' : 'moment_posted',
      entityId: updated._id,
      push: {
        body: both ? (name) => `${name} cũng đã chụp Khoảnh khắc. Xem ảnh của hai bạn 📸` : (name) => `${name} đã chụp Khoảnh khắc. Tới lượt bạn!`,
        url: '/moments',
        tag: `moment:${m.localDate}`,
      },
    });
    return (await viewsOf(couple, [updated], userId, now))[0];
  },

  /**
   * "Đăng lên Story" from a day on which both posted: one story by the caller with both photos (the moment's own objects,
   * shared with the story) and both captions. Once per day; again only if that story has been deleted.
   */
  async toStory(couple: CoupleDoc, userId: string, localDate: string): Promise<{ moment: MomentDayView; story: StoryView }> {
    const m = await momentRepository.findDay(couple._id, localDate);
    if (!m) throw Errors.notFound('Không có Khoảnh khắc nào ngày này');
    if (m.posts.length < 2) throw new AppError(409, 'MOMENT_NOT_BOTH', 'Khi cả hai cùng chụp xong, bạn mới đăng được lên Story.');
    if (m.storyId && (await storyRepository.aliveIds(couple._id, [m.storyId])).size > 0) {
      throw new AppError(409, 'MOMENT_STORY_EXISTS', 'Khoảnh khắc này đã có trên Story rồi.', { storyId: m.storyId.toString() });
    }

    const names = await userRepository.findDisplayNames(couple.memberIds);
    const posts = [...m.posts].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    const lines = posts
      .filter((p) => p.caption)
      .map((p) => `${shortName(names.get(p.userId.toString()) ?? 'Người ấy')}: ${p.caption}`);
    const head = `📸 Khoảnh khắc đôi · ${formatDayVi(localDate)}`;
    const story = await storyService.create(
      couple,
      userId,
      {
        body: lines.length ? `${head}\n\n${lines.join('\n')}` : head,
        mood: null,
        happenedOn: localDate,
        photos: posts.map((p) => ({ key: p.key, width: p.width, height: p.height })),
      },
      { notify: false, sharedPhotos: ['moments'] },
    );

    const uid = new Types.ObjectId(userId);
    const linked = await momentRepository.setStory(couple._id, m._id, m.storyId ?? null, new Types.ObjectId(story.id));
    if (!linked) {
      // The partner tapped at the same moment and won: take this duplicate post back.
      await storyRepository.softDelete(couple._id, story.id, uid);
      const current = await momentRepository.findDay(couple._id, localDate);
      throw new AppError(409, 'MOMENT_STORY_EXISTS', 'Khoảnh khắc này đã có trên Story rồi.', { storyId: current?.storyId?.toString() ?? null });
    }
    logger.info('Duo moment posted to Story', { coupleId: couple._id.toString(), userId, localDate, storyId: story.id });
    await notificationService.toPartner(couple, uid, {
      type: 'couple_story',
      entityId: new Types.ObjectId(story.id),
      push: {
        body: (name) => `${name} đã đăng Khoảnh khắc ngày ${formatDayVi(localDate)} lên Story`,
        url: `/stories/${story.id}`,
        tag: `story:${story.id}`,
      },
    });
    return { moment: (await viewsOf(couple, [linked], userId, new Date()))[0], story };
  },

  /** Home pulse: today's state from the caller's side (creates the day on first use; never reveals the time before it). */
  async pulse(couple: CoupleDoc, userId: string): Promise<PulseMoment> {
    const now = new Date();
    const m = await ensureToday(couple, now);
    const state = stateOf(m, userId, now, closesAtOf(m.localDate, couple.timezone));
    return {
      state,
      windowEndsAt: m.promptAt.getTime() <= now.getTime() ? new Date(m.promptAt.getTime() + MOMENT_ON_TIME_MIN * MIN_MS).toISOString() : null,
      partnerPosted: m.posts.some((p) => p.userId.toString() !== userId),
    };
  },
};
