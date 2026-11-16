import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import { BUCKET_IDEAS, BUCKET_IDEAS_BY_ID } from '../config/bucketIdeas.js';
import { ECONOMY } from '../config/economy.js';
import type { CoupleDoc } from '../models/Couple.js';
import {
  BucketItem,
  BUCKET_CATEGORIES,
  BUCKET_CATEGORY_INFO,
  type BucketCategory,
  type BucketItemDoc,
  type BucketStatus,
} from '../models/BucketItem.js';
import type { StoryPhoto } from '../models/Story.js';
import { bucketRepository, bucketRewardDayRepository, type BucketContent } from '../repositories/bucket.repository.js';
import { storyRepository } from '../repositories/story.repository.js';
import { notificationService } from './notification.service.js';
import { storyService, type StoryView } from './story.service.js';
import { walletService } from './wallet.service.js';
import { finishBucketCompletion } from './bucketCompletion.service.js';
import { addDays, formatDayVi, getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// "Bucket list chung" (plan/ENGINEERING_WORKFLOW.md, CP3). Either member adds, edits, pins, deletes, completes or reopens any item.
// Reward (owner decision 4, 10/11/2026): ECONOMY.bucket, once per item ever, item created ≥ 24 h before completion,
// at most 2 rewarded items per couple-timezone day. Titles, notes and feelings are never logged.

/** Marking an item done can be undone for 24 hours. */
const REOPEN_WINDOW_MS = 24 * 3_600_000;
/**
 * The day it was done may be up to 30 days before the day the item was added (something done just before it was written
 * down), never earlier and never in the future.
 */
export const DONE_ON_SLACK_DAYS = 30;

export interface BucketItemView {
  id: string;
  title: string;
  emoji: string;
  category: BucketCategory;
  note: string;
  dueOn: string | null;
  pinned: boolean;
  ideaId: string | null;
  status: BucketStatus;
  doneOn: string | null;
  doneBy: string | null;
  doneAt: string | null;
  doneNote: string;
  /** The memory posted when it was done; null when none was posted or it has been deleted since. */
  storyId: string | null;
  rewarded: boolean;
  /** "Đánh dấu chưa làm" is possible until this time (done items, 24 h after doneAt); null otherwise. */
  reopenUntil: string | null;
  /** Earliest day accepted as doneOn (couple timezone). */
  doneOnMin: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BucketList {
  status: BucketStatus;
  items: BucketItemView[];
  counts: { todo: number; done: number };
}

export type RewardSkipReason = 'too_new' | 'daily_limit' | 'already_rewarded' | 'failed';

export interface CompleteResult {
  item: BucketItemView;
  story: StoryView | null;
  /** Paid for this completion. */
  reward: { coin: number; exp: number; leveledUp: boolean } | null;
  /** Why there was no reward (shown in the sheet); null when rewarded. */
  rewardSkipped: { reason: RewardSkipReason; message: string } | null;
}

export interface BucketInput {
  title?: string;
  emoji?: string;
  category?: BucketCategory;
  note?: string;
  dueOn?: string | null;
  pinned?: boolean;
}

export interface CompleteInput {
  doneOn?: string | null;
  note?: string;
  photos: StoryPhoto[];
  postStory: boolean;
}

const notFound = () => Errors.notFound('Mục này không còn trong danh sách');

const SKIP_MESSAGES: Record<RewardSkipReason, string> = {
  too_new: `Không có thưởng vì mục này mới thêm chưa đủ ${ECONOMY.bucket.minAgeHours} giờ.`,
  daily_limit: `Không có thưởng vì hôm nay hai bạn đã nhận thưởng cho ${ECONOMY.bucket.maxRewardsPerDay} mục rồi.`,
  already_rewarded: 'Mục này đã nhận thưởng trước đây. Mỗi mục chỉ thưởng một lần.',
  failed: 'Chưa cộng được thưởng do lỗi máy chủ.',
};

function todayOf(couple: CoupleDoc): string {
  return getLocalDate(new Date(), couple.timezone);
}

function doneOnMinOf(couple: CoupleDoc, item: BucketItemDoc): string {
  return addDays(getLocalDate(item.createdAt, couple.timezone), -DONE_ON_SLACK_DAYS);
}

function viewOf(couple: CoupleDoc, it: BucketItemDoc, storyAlive: boolean): BucketItemView {
  const reopenUntil = it.status === 'done' && it.doneAt ? new Date(it.doneAt.getTime() + REOPEN_WINDOW_MS) : null;
  return {
    id: it._id.toString(),
    title: it.title,
    emoji: it.emoji,
    category: it.category,
    note: it.note ?? '',
    dueOn: it.dueOn ?? null,
    pinned: it.pinned,
    ideaId: it.ideaId ?? null,
    status: it.status,
    doneOn: it.doneOn ?? null,
    doneBy: it.doneBy ? it.doneBy.toString() : null,
    doneAt: it.doneAt ? it.doneAt.toISOString() : null,
    doneNote: it.doneNote ?? '',
    storyId: it.storyId && storyAlive ? it.storyId.toString() : null,
    rewarded: it.rewardIntent ? Boolean(it.rewardCompletedAt) : Boolean(it.rewardedAt),
    reopenUntil: reopenUntil && reopenUntil.getTime() > Date.now() ? reopenUntil.toISOString() : null,
    doneOnMin: doneOnMinOf(couple, it),
    createdBy: it.createdBy.toString(),
    updatedBy: it.updatedBy.toString(),
    createdAt: it.createdAt.toISOString(),
    updatedAt: it.updatedAt.toISOString(),
  };
}

/** Views of a few items, with "is its story still there" checked in one query. */
async function viewsOf(couple: CoupleDoc, items: BucketItemDoc[]): Promise<BucketItemView[]> {
  const storyIds = items.map((i) => i.storyId).filter((id): id is Types.ObjectId => id !== null && id !== undefined);
  const alive = await storyRepository.aliveIds(couple._id, storyIds);
  return items.map((i) => viewOf(couple, i, i.storyId ? alive.has(i.storyId.toString()) : false));
}

async function oneView(couple: CoupleDoc, item: BucketItemDoc): Promise<BucketItemView> {
  return (await viewsOf(couple, [item]))[0];
}

/** Defaults and trimming; the emoji follows the category when not chosen. */
function normalize(input: Required<Pick<BucketInput, 'title' | 'category'>> & BucketInput): BucketContent {
  return {
    title: input.title.trim(),
    emoji: input.emoji?.trim() || BUCKET_CATEGORY_INFO[input.category].emoji,
    category: input.category,
    note: (input.note ?? '').trim(),
    dueOn: input.dueOn ?? null,
    pinned: input.pinned ?? false,
  };
}

/** "✅ <tiêu đề>" + the feeling, as in the plan. */
function storyBody(item: BucketItemDoc, feeling: string): string {
  const head = `✅ ${item.title}`;
  return feeling ? `${head}\n\n${feeling}` : head;
}

export const bucketService = {
  async list(couple: CoupleDoc, status: BucketStatus): Promise<BucketList> {
    const [docs, counts] = await Promise.all([bucketRepository.list(couple._id, status), bucketRepository.counts(couple._id)]);
    for (const doc of docs) {
      if (doc.completion?.ready === false || (doc.rewardIntent && !doc.rewardCompletedAt)) await tryReward(couple, doc.rewardIntent?.actorUserId ?? doc.doneBy!.toString(), doc);
    }
    return { status, items: await viewsOf(couple, docs), counts };
  },

  async ideas(couple: CoupleDoc) {
    const added = await bucketRepository.addedIdeaIds(couple._id);
    return {
      categories: BUCKET_CATEGORIES.map((key) => ({ key, ...BUCKET_CATEGORY_INFO[key] })),
      ideas: BUCKET_IDEAS.map((i) => ({ ...i, added: added.has(i.id) })),
    };
  },

  /** With `ideaId`, the title, emoji and category come from the idea unless given. New items push nothing (plan). */
  async create(couple: CoupleDoc, userId: string, input: BucketInput & { ideaId?: string | null }): Promise<BucketItemView> {
    const idea = input.ideaId ? BUCKET_IDEAS_BY_ID.get(input.ideaId) : null;
    if (input.ideaId && !idea) throw Errors.badRequest('Gợi ý này không còn nữa');
    const title = input.title ?? idea?.title;
    if (!title) throw Errors.badRequest('Hãy đặt tên cho mục này');
    const content = normalize({
      ...input,
      title,
      emoji: input.emoji ?? idea?.emoji,
      category: input.category ?? idea?.category ?? 'other',
    });
    const doc = await bucketRepository.create({
      ...content,
      coupleId: couple._id,
      createdBy: new Types.ObjectId(userId),
      ideaId: idea?.id ?? null,
    });
    await realtimeAudience.couple(couple._id, ['bucket']);
    logger.info('Bucket item created', {
      coupleId: couple._id.toString(),
      userId,
      itemId: doc._id.toString(),
      category: doc.category,
      ideaId: doc.ideaId,
    });
    return oneView(couple, doc);
  },

  /** Either member, any field, todo or done. */
  async update(couple: CoupleDoc, userId: string, id: string, patch: BucketInput): Promise<BucketItemView> {
    const existing = await bucketRepository.findById(couple._id, id);
    if (!existing) throw notFound();
    const merged = {
      title: patch.title ?? existing.title,
      emoji: patch.emoji ?? existing.emoji,
      category: patch.category ?? existing.category,
      note: patch.note ?? existing.note,
      dueOn: patch.dueOn !== undefined ? patch.dueOn : existing.dueOn,
      pinned: patch.pinned ?? existing.pinned,
    };
    const doc = await bucketRepository.update(couple._id, existing._id, normalize(merged), new Types.ObjectId(userId));
    if (!doc) throw notFound(); // deleted by the partner a moment ago
    await realtimeAudience.couple(couple._id, ['bucket']);
    logger.info('Bucket item updated', { coupleId: couple._id.toString(), userId, itemId: id, pinned: doc.pinned });
    return oneView(couple, doc);
  },

  /** Soft delete; either member. The story posted for it stays (it belongs to its author). */
  async remove(couple: CoupleDoc, userId: string, id: string): Promise<void> {
    const doc = await bucketRepository.softDelete(couple._id, id, new Types.ObjectId(userId));
    if (!doc) throw notFound();
    await realtimeAudience.couple(couple._id, ['bucket']);
    logger.info('Bucket item deleted', { coupleId: couple._id.toString(), userId, itemId: id });
  },

  /** "Hoàn tác" after a delete. Restoring an item that is not deleted returns it as it is. */
  async restore(couple: CoupleDoc, userId: string, id: string): Promise<BucketItemView> {
    const doc = await bucketRepository.restore(couple._id, id, new Types.ObjectId(userId));
    if (doc) {
      await realtimeAudience.couple(couple._id, ['bucket']);
      logger.info('Bucket item restored', { coupleId: couple._id.toString(), userId, itemId: id });
      return oneView(couple, doc);
    }
    const current = await bucketRepository.findById(couple._id, id);
    if (!current) throw Errors.notFound('Không tìm thấy mục này');
    return oneView(couple, current);
  },

  /**
   * "Đã làm xong 🎉": mark it done (one request wins), post the story of the person who tapped (optional, with the photos),
   * Freeze reward and optional story intent in that same write. An unknown story outcome stays gated for recovery.
   */
  async complete(couple: CoupleDoc, userId: string, id: string, input: CompleteInput): Promise<CompleteResult> {
    const item = await bucketRepository.findById(couple._id, id);
    if (!item) throw notFound();
    if (item.status === 'done') {
      if (!item.rewardIntent && !item.completion) throw new AppError(409, 'BUCKET_ALREADY_DONE', 'Mục này đã được đánh dấu làm xong rồi');
      const { reward, skipped } = await tryReward(couple, userId, item);
      return { item: await oneView(couple, item), story: null, reward,
        rewardSkipped: skipped ? { reason: skipped, message: SKIP_MESSAGES[skipped] } : null };
    }

    const today = todayOf(couple);
    const doneOn = input.doneOn ?? today;
    if (doneOn > today) throw Errors.badRequest('Ngày làm không thể ở tương lai');
    const min = doneOnMinOf(couple, item);
    if (doneOn < min) throw Errors.badRequest(`Ngày làm không thể trước ${formatDayVi(min)}`);
    if (!input.postStory && input.photos.length > 0) throw Errors.badRequest('Ảnh chỉ đi kèm bài Story. Hãy bật "Đăng lên Story" hoặc bỏ ảnh.');
    const feeling = (input.note ?? '').trim();

    const uid = new Types.ObjectId(userId);
    const now = new Date();
    const storyInput = { body: storyBody(item, feeling), mood: null, happenedOn: doneOn, photos: input.photos };
    if (input.postStory) await storyService.validateCreate(couple, userId, storyInput);
    const eligible = !item.rewardedAt && !item.rewardIntent && !item.rewardDenied && item.createdAt.getTime() <= now.getTime() - ECONOMY.bucket.minAgeHours * 3_600_000;
    const rewardIntent = eligible ? { operationId: `bucket:${item._id}`, actorUserId: userId, ownerUserId: null,
      coin: ECONOMY.bucket.coin, exp: ECONOMY.bucket.exp, localDate: getLocalDate(now, couple.timezone) } : null;
    const completion = { version: 1 as const, ready: !input.postStory,
      story: input.postStory ? { id: new Types.ObjectId().toString(), actorUserId: userId, body: storyInput.body, happenedOn: doneOn, photos: input.photos } : null };
    const done = await bucketRepository.markDone(couple._id, item._id, { doneOn, doneBy: uid, doneAt: now, doneNote: feeling, completion }, rewardIntent);
    if (!done) {
      // The partner completed or deleted it a moment ago.
      if (!(await bucketRepository.findById(couple._id, item._id))) throw notFound();
      throw new AppError(409, 'BUCKET_ALREADY_DONE', 'Mục này đã được đánh dấu làm xong rồi');
    }

    await realtimeAudience.couple(couple._id, ['bucket']);
    let story: StoryView | null = null;
    const { reward, skipped } = await tryReward(couple, userId, done);
    if (done.storyId) {
      try { story = await storyService.get(couple, userId, done.storyId.toString()); }
      catch { /* A deleted memory remains a durable completion; never recreate it. */ }
    }
    logger.info('Bucket item done', {
      coupleId: couple._id.toString(),
      userId,
      itemId: id,
      story: story !== null,
      photos: input.photos.length,
      rewarded: reward !== null,
      skipped: skipped ?? undefined,
    });

    const title = done.title;
    await notificationService.toPartner(couple, uid, {
      type: 'bucket_done',
      entityId: done._id, eventKey: `${done._id}:${done.doneAt!.toISOString()}`,
      target: { kind: 'bucket', id: String(done._id) },
      push: {
        body: `Hai bạn đã làm xong “${title}” 🎉`,
        url: story ? `/stories/${story.id}` : '/quests/bucket?tab=done',
        tag: `bucket:${done._id.toString()}`,
      },
    });

    return {
      item: viewOf(couple, done, story !== null),
      story,
      reward,
      rewardSkipped: skipped ? { reason: skipped, message: SKIP_MESSAGES[skipped] } : null,
    };
  },

  /** "Đánh dấu chưa làm" within 24 hours. The story stays (its author deletes it if they want); the reward is kept and never paid again. */
  async reopen(couple: CoupleDoc, userId: string, id: string): Promise<BucketItemView> {
    const item = await bucketRepository.findById(couple._id, id);
    if (!item) throw notFound();
    if (item.status !== 'done') throw new AppError(409, 'BUCKET_NOT_DONE', 'Mục này vẫn đang ở "Chưa làm"');
    if (item.completion?.ready === false) throw Errors.conflict('Kỷ niệm đang được hoàn tất. Hãy thử lại trước khi mở lại mục này.');
    const doc = await bucketRepository.reopen(couple._id, item._id, new Date(Date.now() - REOPEN_WINDOW_MS), new Types.ObjectId(userId));
    if (!doc) {
      const current = await bucketRepository.findById(couple._id, item._id);
      if (!current) throw notFound();
      if (current.status !== 'done') throw new AppError(409, 'BUCKET_NOT_DONE', 'Mục này vẫn đang ở "Chưa làm"');
      throw new AppError(409, 'BUCKET_REOPEN_EXPIRED', 'Chỉ đánh dấu chưa làm được trong 24 giờ sau khi làm xong');
    }
    await realtimeAudience.couple(couple._id, ['bucket']);
    logger.info('Bucket item reopened', { coupleId: couple._id.toString(), userId, itemId: id });
    return oneView(couple, doc);
  },
};

/**
 * Persist the immutable reward intent with the claim, then reserve an idempotent daily slot before payment.
 * Neither claim nor slot is reset after an unknown outcome; retries resume the original operation.
 */
async function tryReward(
  couple: CoupleDoc,
  userId: string,
  item: BucketItemDoc,
): Promise<{ reward: CompleteResult['reward']; skipped: RewardSkipReason | null }> {
  const cfg = ECONOMY.bucket;
  try { if (!(await finishBucketCompletion(couple, item))) return { reward: null, skipped: 'failed' }; }
  catch { return { reward: null, skipped: 'failed' }; }
  if (item.completion && !item.rewardIntent) return { reward: null, skipped: item.rewardedAt ? 'already_rewarded' : 'too_new' };
  if (item.rewardDenied) return { reward: null, skipped: 'daily_limit' };
  if (item.rewardedAt && !item.rewardIntent) return { reward: null, skipped: 'already_rewarded' };
  // Eligibility and amounts were frozen with the completion; no historical done flag can invent a payment.
  if (!item.rewardIntent) return { reward: null, skipped: 'already_rewarded' };
  const saved = item.rewardIntent;
  // Reserve a slot idempotently. Never give it or the source claim back after an unknown outcome.
  if (!(await bucketRewardDayRepository.take(couple._id, saved.localDate!, cfg.maxRewardsPerDay, saved.operationId))) {
    await BucketItem.updateOne({ _id: item._id, rewardCompletedAt: null }, { $set: { rewardDenied: true } }).exec();
    item.rewardDenied = true;
    return { reward: null, skipped: 'daily_limit' };
  }
  try {
    const paid = await walletService.reward({ ...saved, coupleId: couple._id, reason: 'bucket_list', refId: item._id });
    const completedAt = new Date();
    await BucketItem.updateOne({ _id: item._id, rewardCompletedAt: null }, { $set: { rewardCompletedAt: completedAt } }).exec();
    item.rewardCompletedAt = completedAt;
    return { reward: { coin: saved.coin, exp: saved.exp, leveledUp: paid.leveledUp ?? false }, skipped: null };
  } catch (err) {
    logger.error('Bucket reward pending recovery', { coupleId: couple._id.toString(), userId, itemId: item._id.toString(), message: (err as Error).message });
    return { reward: null, skipped: 'failed' };
  }
}
