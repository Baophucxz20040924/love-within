import { realtimeAudience } from './realtimeAudience.service.js';
import { randomInt, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { CoupleDoc } from '../models/Couple.js';
import { LEGACY_MOMENT_ON_TIME_MIN, MOMENT_ON_TIME_MIN, MOMENT_WINDOW_FROM, MOMENT_WINDOW_TO, MOMENT_SCHEDULE_VERSION, type DuoMomentDoc, type MomentPost, type MomentSession } from '../models/DuoMoment.js';
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

const MIN_MS = 60_000;
const STREAK_LOOKBACK = 1000;
export type MomentState = 'waiting' | 'open' | 'posted' | 'both' | 'missed';
export interface MomentPhotoView {
  url: string; width: number; height: number; caption: string; postedAt: string; lateMin: number;
}
export interface MomentSessionView {
  localDate: string;
  sessionId: string;
  legacy: boolean;
  scheduleVersion: number;
  state: MomentState;
  promptAt: string;
  /** Compatibility alias for rewardEndsAt, not the capture deadline. */
  windowEndsAt: string;
  rewardEndsAt: string;
  closesAt: string;
  closed: boolean;
  mine: MomentPhotoView | null;
  partner: { posted: boolean; postedAt: string | null; photo: MomentPhotoView | null };
  storyId: string | null;
}
export interface MomentDayView {
  localDate: string;
  legacy: boolean;
  scheduleVersion: number;
  /** Only started sessions. Future times AND IDs are never exposed. */
  sessions: MomentSessionView[];
}
export interface MomentMonthView {
  month: string; today: string; minMonth: string; days: MomentDayView[];
  streak: { current: number; best: number };
}
export interface PulseMoment {
  localDate: string;
  scheduleVersion: number;
  sessionId: string | null;
  state: MomentState;
  windowEndsAt: string | null;
  rewardEndsAt: string | null;
  closesAt: string | null;
  partnerPosted: boolean;
}
export interface MomentTarget { localDate: string; sessionId: string }
export interface MomentPostInput extends MomentTarget { key: string; width: number; height: number; caption: string }
const notYet = () => new AppError(409, 'MOMENT_NOT_YET', 'Chưa tới giờ lượt Khoảnh khắc này.');
const closed = () => new AppError(409, 'MOMENT_CLOSED', 'Ngày Khoảnh khắc đã kết thúc. Hãy chờ ngày tiếp theo.');
const alreadyPosted = () => new AppError(409, 'MOMENT_ALREADY_POSTED', 'Bạn đã chụp Khoảnh khắc hôm nay rồi.');
const legacyError = () => new AppError(409, 'MOMENT_LEGACY_READ_ONLY', 'Khoảnh khắc cũ chỉ để xem. Lịch một lần mỗi ngày bắt đầu từ ngày tiếp theo.');
export function requireMomentTarget(target: Partial<MomentTarget>): asserts target is MomentTarget {
  if (!target.localDate || !target.sessionId) throw new AppError(400, 'MOMENT_SESSION_REQUIRED', 'Hãy tải lại ứng dụng để chọn đúng lượt Khoảnh khắc.');
}
function momentPrefix(coupleId: Types.ObjectId, target: MomentTarget, userId: string): string {
  return `couples/${coupleId}/moments/${target.localDate}/${target.sessionId}/${userId}/`;
}
/** One immutable daily schedule. Drawing late never moves or replaces a missed prompt. */
export function newMomentDay(coupleId: Types.ObjectId, localDate: string, timezone: string, _now?: Date): NewMomentDay {
  const start = zonedTimeToUtc(localDate, MOMENT_WINDOW_FROM, timezone).getTime();
  const end = zonedTimeToUtc(localDate, MOMENT_WINDOW_TO, timezone).getTime();
  const promptAt = new Date(start + randomInt(Math.floor((end - start) / MIN_MS) + 1) * MIN_MS);
  return { coupleId, localDate, scheduleVersion: MOMENT_SCHEDULE_VERSION, timezone,
    sessions: [{ id: randomUUID(), promptAt, rewardEndsAt: new Date(promptAt.getTime() + MOMENT_ON_TIME_MIN * MIN_MS),
      closesAt: zonedTimeToUtc(addDays(localDate, 1), '00:00', timezone), notifiedAt: null, posts: [], storyId: null }],
  };
}
function isLegacy(m: DuoMomentDoc): boolean { return !m.sessions; }
function isReadOnly(m: DuoMomentDoc): boolean { return m.scheduleVersion !== MOMENT_SCHEDULE_VERSION || isLegacy(m); }
function scheduleVersionOf(m: DuoMomentDoc): number { return m.scheduleVersion ?? (isLegacy(m) ? 1 : 2); }
function rewardEndsAtOf(m: DuoMomentDoc, s: MomentSession): Date {
  return m.scheduleVersion === MOMENT_SCHEDULE_VERSION && s.rewardEndsAt
    ? s.rewardEndsAt : new Date(s.promptAt.getTime() + LEGACY_MOMENT_ON_TIME_MIN * MIN_MS);
}
/** Old reads retain photos, captions, lateMin, timestamps and Story links, but never reopen capture. */
function sessionsOf(m: DuoMomentDoc): MomentSession[] {
  return m.sessions ?? [{ id: 'legacy', promptAt: m.promptAt, closesAt: new Date(m.promptAt.getTime() + LEGACY_MOMENT_ON_TIME_MIN * MIN_MS),
    notifiedAt: m.notifiedAt, posts: m.posts, storyId: m.storyId }];
}
function stateOf(s: MomentSession, userId: string, now: Date, legacy = false): MomentState {
  if (s.posts.length >= 2) return 'both';
  if (s.posts.some((p) => p.userId.toString() === userId)) return 'posted';
  if (legacy || now >= s.closesAt) return 'missed';
  return now < s.promptAt ? 'waiting' : 'open';
}
function assertOpen(s: MomentSession, userId: string, now: Date): void {
  if (now >= s.closesAt) throw closed();
  if (now < s.promptAt) throw notYet();
  if (s.posts.some((p) => p.userId.toString() === userId)) throw alreadyPosted();
}
async function getTarget(couple: CoupleDoc, target: MomentTarget): Promise<{ m: DuoMomentDoc; s: MomentSession }> {
  requireMomentTarget(target);
  // Never fall back to today's/current session for a stale request.
  const m = await momentRepository.findDay(couple._id, target.localDate);
  if (!m) throw Errors.notFound('Không có lượt Khoảnh khắc này');
  if (isReadOnly(m)) throw legacyError();
  const s = m.sessions!.find((x) => x.id === target.sessionId);
  if (!s) throw Errors.notFound('Không có lượt Khoảnh khắc này');
  return { m, s };
}
async function photoView(p: MomentPost): Promise<MomentPhotoView> {
  return { url: (await getStorage().getDownloadUrl(p.key, { cacheable: true })).url, width: p.width, height: p.height,
    caption: p.caption, postedAt: p.postedAt.toISOString(), lateMin: p.lateMin };
}
async function viewsOf(couple: CoupleDoc, docs: DuoMomentDoc[], userId: string, now: Date): Promise<MomentDayView[]> {
  const storyIds = docs.flatMap((m) => sessionsOf(m).map((s) => s.storyId)).filter((id): id is Types.ObjectId => !!id);
  const alive = await storyRepository.aliveIds(couple._id, storyIds);
  return Promise.all(docs.map(async (m) => ({
    localDate: m.localDate, legacy: isLegacy(m), scheduleVersion: scheduleVersionOf(m),
    sessions: await Promise.all(sessionsOf(m).filter((s) => s.promptAt <= now).map(async (s): Promise<MomentSessionView> => {
      const mine = s.posts.find((p) => String(p.userId) === userId);
      const partner = s.posts.find((p) => String(p.userId) !== userId);
      const rewardEndsAt = rewardEndsAtOf(m, s).toISOString();
      return { localDate: m.localDate, sessionId: s.id, legacy: isLegacy(m), scheduleVersion: scheduleVersionOf(m), state: stateOf(s, userId, now, isReadOnly(m)),
        promptAt: s.promptAt.toISOString(), windowEndsAt: rewardEndsAt, rewardEndsAt, closesAt: s.closesAt.toISOString(), closed: isReadOnly(m) || now >= s.closesAt,
        mine: mine ? await photoView(mine) : null,
        partner: { posted: !!partner, postedAt: partner?.postedAt.toISOString() ?? null, photo: partner && mine ? await photoView(partner) : null },
        storyId: s.storyId && alive.has(String(s.storyId)) ? String(s.storyId) : null,
      };
    })),
  })));
}
async function ensureToday(couple: CoupleDoc, now: Date): Promise<DuoMomentDoc> {
  const localDate = getLocalDate(now, couple.timezone);
  return await momentRepository.findDay(couple._id, localDate) ?? await momentRepository.ensureDay(newMomentDay(couple._id, localDate, couple.timezone));
}
function shortName(displayName: string): string { return displayName.trim().split(/\s+/).at(-1) || displayName; }
export function streakOf(bothDays: string[], today: string): { current: number; best: number } {
  const set = new Set(bothDays);
  let current = 0;
  let day = set.has(today) ? today : addDays(today, -1);
  while (set.has(day)) { current += 1; day = addDays(day, -1); }
  let best = 0, run = 0;
  let prev: string | null = null;
  for (const d of [...set].sort().reverse()) {
    run = prev !== null && addDays(prev, -1) === d ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  return { current, best: Math.max(best, current) };
}
export const momentService = {
  async today(couple: CoupleDoc, userId: string): Promise<MomentDayView> {
    const m = await ensureToday(couple, new Date());
    return (await viewsOf(couple, [m], userId, new Date()))[0];
  },
  async month(couple: CoupleDoc, userId: string, month: string): Promise<MomentMonthView> {
    const today = getLocalDate(new Date(), couple.timezone);
    if (month === today.slice(0, 7)) await ensureToday(couple, new Date());
    const [docs, both] = await Promise.all([momentRepository.listRange(couple._id, `${month}-01`, `${month}-31`), momentRepository.bothDays(couple._id, STREAK_LOOKBACK)]);
    return { month, today, minMonth: getLocalDate(couple.createdAt, couple.timezone).slice(0, 7),
      days: await viewsOf(couple, docs, userId, new Date()), streak: streakOf(both, today) };
  },
  async createUploadUrl(couple: CoupleDoc, userId: string, target: MomentTarget, mimeType: string, sizeBytes: number) {
    const { s } = await getTarget(couple, target);
    assertOpen(s, userId, new Date());
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');
    const imageKey = `${momentPrefix(couple._id, target, userId)}${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    assertOpen(s, userId, new Date());
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },
  async post(couple: CoupleDoc, userId: string, input: MomentPostInput): Promise<MomentDayView> {
    const { m, s } = await getTarget(couple, input);
    assertOpen(s, userId, new Date());
    const uid = new Types.ObjectId(userId);
    if (!input.key.startsWith(momentPrefix(couple._id, input, userId)) || input.key.includes('..')) throw Errors.forbidden('Ảnh không thuộc lượt chụp của bạn');
    const head = await getStorage().headObject(input.key);
    if (!head) throw Errors.badRequest('Ảnh chưa tải lên xong. Thử đăng lại nhé.');
    if (head.size > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');
    const now = new Date();
    assertOpen(s, userId, now);
    const post: Omit<MomentPost, 'postedAt' | 'lateMin'> = { userId: uid, key: input.key, width: input.width, height: input.height, caption: input.caption.trim() };
    const updated = await momentRepository.addPost(couple._id, m.localDate, s.id, post);
    if (!updated) {
      const current = await momentRepository.findDay(couple._id, m.localDate);
      if (current?.sessions?.find((x) => x.id === s.id)?.posts.some((p) => p.userId.equals(uid))) throw alreadyPosted();
      // DB time may already be beyond the boundary even if this process's clock is behind.
      throw closed();
    }
    await realtimeAudience.couple(couple._id, ['moments']);
    const savedSession = updated.sessions!.find((x) => x.id === s.id)!;
    const both = savedSession.posts.length >= 2;
    const savedPost = savedSession.posts.find((p) => p.userId.equals(uid))!;
    const rewardEndsAt = rewardEndsAtOf(updated, savedSession);
    logger.info('Duo moment posted', { coupleId: String(couple._id), userId, localDate: m.localDate, sessionId: s.id, lateMin: savedPost.lateMin, both });
    await questService.refresh(couple, DUO_MOMENT_QUEST_KEY, m.localDate);
    // Late pairs still get a neutral invitation to view; never invite a late partner to earn the reward.
    if (both || (savedPost.postedAt < rewardEndsAt && new Date() < rewardEndsAt)) {
      await notificationService.toPartner(couple, uid, {
        type: both ? 'moment_both' : 'moment_posted', entityId: updated._id,
        eventKey: `${updated._id}:${s.id}:${uid}`,
        target: { kind: 'moment', dayId: String(updated._id), localDate: m.localDate, sessionId: s.id },
        push: { body: both ? (name) => `${name} cũng đã chụp Khoảnh khắc. Xem ảnh của hai bạn` : (name) => `${name} đã chụp Khoảnh khắc. Chụp trước hạn thưởng để cùng nhận 40 Xu!`,
          url: `/moments?date=${m.localDate}&session=${s.id}`, tag: `moment:${m.localDate}:${s.id}`, expiresAt: both ? undefined : rewardEndsAt.toISOString() },
      });
    }
    return (await viewsOf(couple, [updated], userId, new Date()))[0];
  },
  async toStory(couple: CoupleDoc, userId: string, target: MomentTarget): Promise<{ moment: MomentDayView; story: StoryView }> {
    const { m, s } = await getTarget(couple, target);
    if (s.posts.length < 2) throw new AppError(409, 'MOMENT_NOT_BOTH', 'Cả hai cần chụp trong cùng lượt để đăng lên Story.');
    if (s.storyId && (await storyRepository.aliveIds(couple._id, [s.storyId])).size > 0) throw new AppError(409, 'MOMENT_STORY_EXISTS', 'Khoảnh khắc này đã có trên Story rồi.', { storyId: String(s.storyId) });
    const names = await userRepository.findDisplayNames(couple.memberIds);
    const posts = [...s.posts].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    const lines = posts.filter((p) => p.caption).map((p) => `${shortName(names.get(String(p.userId)) ?? 'Người ấy')}: ${p.caption}`);
    const title = `Khoảnh khắc đôi · ${formatDayVi(m.localDate)}`;
    const story = await storyService.create(couple, userId, {
      body: lines.length ? `${title}\n\n${lines.join('\n')}` : title, mood: null, happenedOn: m.localDate,
      photos: posts.map((p) => ({ key: p.key, width: p.width, height: p.height })),
    }, { notify: false, sharedPhotos: ['moments'] });
    const uid = new Types.ObjectId(userId);
    const linked = await momentRepository.setStory(couple._id, m._id, s.id, s.storyId ?? null, new Types.ObjectId(story.id));
    if (!linked) {
      await storyRepository.softDelete(couple._id, story.id, uid);
      await realtimeAudience.couple(couple._id, ['stories']);
      throw new AppError(409, 'MOMENT_STORY_EXISTS', 'Khoảnh khắc này đã có trên Story rồi.');
    }
    await realtimeAudience.couple(couple._id, ['moments']);
    await notificationService.toPartner(couple, uid, { type: 'couple_story', entityId: new Types.ObjectId(story.id),
      eventKey: story.id, target: { kind: 'story', id: story.id }, push: {
      body: (name) => `${name} đã đăng Khoảnh khắc ngày ${formatDayVi(m.localDate)} lên Story`, url: `/stories/${story.id}`, tag: `story:${story.id}`,
    } });
    return { moment: (await viewsOf(couple, [linked], userId, new Date()))[0], story };
  },
  async pulse(couple: CoupleDoc, userId: string): Promise<PulseMoment> {
    const m = await ensureToday(couple, new Date());
    const now = new Date();
    const s = !isReadOnly(m) ? m.sessions!.find((s) => s.promptAt <= now && now < s.closesAt) : undefined;
    const rewardEndsAt = s ? rewardEndsAtOf(m, s).toISOString() : null;
    return { localDate: m.localDate, scheduleVersion: scheduleVersionOf(m), sessionId: s?.id ?? null, state: s ? stateOf(s, userId, now) : 'waiting',
      windowEndsAt: rewardEndsAt, rewardEndsAt, closesAt: s?.closesAt.toISOString() ?? null,
      partnerPosted: s?.posts.some((p) => String(p.userId) !== userId) ?? false };
  },
};
