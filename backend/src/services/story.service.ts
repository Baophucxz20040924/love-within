import { realtimeAudience } from './realtimeAudience.service.js';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { CoupleDoc } from '../models/Couple.js';
import { MAX_STORY_PHOTOS, type Mood, type ReactionType, type StoryDoc, type StoryPhoto, type StoryVideo } from '../models/Story.js';
import { createStoryVideoUploadUrl, normalizeStoryVideos, sameStoryVideos, storyVideoPrefix, validateStoryPhotoHead, validateStoryVideos } from './storyMedia.service.js';
import type { StoryCommentDoc } from '../models/StoryComment.js';
import { getStorage } from '../integrations/index.js';
import { storyCommentRepository, storyRepository, type StoryContent } from '../repositories/story.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { notificationService } from './notification.service.js';
import { getLocalDate } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../utils/historyCursor.js';

export const STORY_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface StoryInput {
  body: string;
  mood?: Mood | null;
  happenedOn?: string | null;
  photos: StoryPhoto[];
  /** Create omission means []; edit omission preserves existing videos. */
  videos?: StoryVideo[];
}

export interface StoryView {
  id: string;
  author: { id: string; displayName: string };
  isMine: boolean;
  body: string;
  mood: Mood | null;
  happenedOn: string;
  photos: { key: string; url: string; width: number; height: number }[];
  videos: (StoryVideo & { url: string })[];
  reactions: { mine: ReactionType | null; partner: ReactionType | null };
  commentCount: number;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentView {
  id: string;
  author: { id: string; displayName: string };
  isMine: boolean;
  body: string;
  createdAt: string;
}

type Names = Map<string, string>;

function memberNames(couple: CoupleDoc): Promise<Names> {
  return userRepository.findDisplayNames(couple.memberIds);
}

function partnerOf(couple: CoupleDoc, userId: string): Types.ObjectId | null {
  return couple.memberIds.find((m) => m.toString() !== userId) ?? null;
}

function storyPrefix(coupleId: Types.ObjectId): string {
  return `couples/${coupleId.toString()}/stories/`;
}

/**
 * Photos of another feature that a story made by that feature may show (CP6 "Đăng lên Story": both photos of a duo moment).
 * The story points at the same objects (no copy); they stay owned by that feature, so a story edit that drops one never
 * deletes it from storage.
 */
export type SharedPhotoFeature = 'moments';

function sharedPrefix(coupleId: Types.ObjectId, feature: SharedPhotoFeature): string {
  return `couples/${coupleId.toString()}/${feature}/`;
}

async function toView(s: StoryDoc, userId: string, names: Names): Promise<StoryView> {
  const storage = getStorage();
  const photos = await Promise.all(
    s.photos.map(async (p) => ({
      key: p.key,
      width: p.width,
      height: p.height,
      url: (await storage.getDownloadUrl(p.key, { cacheable: true })).url,
    })),
  );
  const videos = await Promise.all((s.videos ?? []).map(async (v) => ({
    key: v.key, mimeType: v.mimeType, width: v.width, height: v.height,
    url: (await storage.getDownloadUrl(v.key, { cacheable: true })).url,
  })));
  let mine: ReactionType | null = null;
  let partner: ReactionType | null = null;
  for (const [uid, type] of s.reactions ?? new Map<string, ReactionType>()) {
    if (uid === userId) mine = type;
    else partner = type;
  }
  const authorId = s.authorId.toString();
  return {
    id: s._id.toString(),
    author: { id: authorId, displayName: names.get(authorId) ?? 'Người ấy' },
    isMine: authorId === userId,
    body: s.body,
    mood: s.mood ?? null,
    happenedOn: s.happenedOn,
    photos,
    videos,
    reactions: { mine, partner },
    commentCount: s.commentCount ?? 0,
    createdAt: s.createdAt.toISOString(),
    editedAt: s.editedAt ? s.editedAt.toISOString() : null,
  };
}

function toCommentView(c: StoryCommentDoc, userId: string, names: Names): CommentView {
  const authorId = c.authorId.toString();
  return {
    id: c._id.toString(),
    author: { id: authorId, displayName: names.get(authorId) ?? 'Người ấy' },
    isMine: authorId === userId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Trim, apply defaults and reject empty posts / future dates. */
function normalize(couple: CoupleDoc, input: StoryInput, retainedVideos: StoryVideo[] = []): StoryContent & { videos: StoryVideo[] } {
  const body = input.body.trim();
  const videos = normalizeStoryVideos(input.photos, input.videos ?? retainedVideos);
  if (!body && input.photos.length === 0 && videos.length === 0) throw Errors.badRequest('Hãy viết gì đó hoặc thêm ảnh/video');
  const today = getLocalDate(new Date(), couple.timezone);
  const happenedOn = input.happenedOn ?? today;
  if (happenedOn > today) throw Errors.badRequest('Ngày kỷ niệm không thể ở tương lai');
  return {
    body,
    mood: input.mood ?? null,
    happenedOn,
    photos: input.photos.map((p) => ({ key: p.key, width: p.width, height: p.height })),
    videos,
  };
}

/**
 * Photos must live under this couple's story prefix (or a shared prefix the calling feature allows) and must really
 * exist in storage (prevents attaching another couple's objects or keys that were never uploaded). Photos the story
 * already has were checked when they were attached (a story made from a moment keeps its moment photos when edited).
 */
async function validatePhotos(
  couple: CoupleDoc,
  userId: string,
  photos: StoryPhoto[],
  alreadyAttached: Set<string>,
  shared: SharedPhotoFeature[] = [],
): Promise<void> {
  if (photos.length > MAX_STORY_PHOTOS) throw Errors.badRequest(`Tối đa ${MAX_STORY_PHOTOS} ảnh mỗi bài viết`);
  const prefixes = [storyPrefix(couple._id), ...shared.map((f) => sharedPrefix(couple._id, f))];
  const seen = new Set<string>();
  const toCheck: string[] = [];
  for (const p of photos) {
    const attached = alreadyAttached.has(p.key);
    if ((!attached && !prefixes.some((prefix) => p.key.startsWith(prefix))) || p.key.includes('..')) {
      logger.warn('Rejected foreign story photo key', { coupleId: couple._id.toString(), userId, key: p.key });
      throw Errors.forbidden('Ảnh không thuộc couple của bạn');
    }
    if (seen.has(p.key)) throw Errors.badRequest('Có ảnh bị trùng');
    seen.add(p.key);
    if (!attached) toCheck.push(p.key);
  }
  // One storage HEAD per new photo, in parallel (up to 10 network round trips otherwise).
  const heads = await Promise.all(toCheck.map((key) => getStorage().headObject(key)));
  for (const head of heads) {
    validateStoryPhotoHead(head, env.s3.maxUploadBytes);
  }
}

function sameContent(a: StoryContent, b: StoryDoc): boolean {
  return (
    a.body === b.body &&
    a.mood === (b.mood ?? null) &&
    a.happenedOn === b.happenedOn &&
    sameStoryVideos(a.videos, b.videos) &&
    a.photos.length === b.photos.length &&
    a.photos.every((p, i) => p.key === b.photos[i].key)
  );
}

async function requireStory(couple: CoupleDoc, id: string): Promise<StoryDoc> {
  const story = await storyRepository.findById(couple._id, id);
  if (!story) throw Errors.notFound('Bài viết không tồn tại hoặc đã bị xóa');
  return story;
}

/** Load the story and make sure the caller wrote it (403 for the partner, 404 for anyone else). */
async function requireOwnStory(couple: CoupleDoc, userId: string, id: string): Promise<StoryDoc> {
  const story = await requireStory(couple, id);
  if (story.authorId.toString() !== userId) throw Errors.forbidden('Chỉ người đăng mới sửa hoặc xóa được bài viết này');
  return story;
}

export const storyService = {
  async feed(couple: CoupleDoc, userId: string, cursor: string | undefined, limit: number) {
    const [docs, me, names] = await Promise.all([
      storyRepository.list(couple._id, cursor, limit),
      userRepository.findById(userId),
      memberNames(couple),
    ]);
    const page = docs.slice(0, limit);
    const nextCursor = docs.length > limit ? page[page.length - 1]._id.toString() : null;
    return {
      items: await Promise.all(page.map((s) => toView(s, userId, names))),
      nextCursor,
      /** When the caller last opened the feed — the client marks partner posts newer than this as "Mới". */
      seenAt: me?.storiesSeenAt ? me.storiesSeenAt.toISOString() : null,
    };
  },

  async get(couple: CoupleDoc, userId: string, id: string): Promise<StoryView> {
    const [story, names] = await Promise.all([requireStory(couple, id), memberNames(couple)]);
    return toView(story, userId, names);
  },

  async createUploadUrl(couple: CoupleDoc, mimeType: string, sizeBytes: number) {
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const month = getLocalDate(new Date(), couple.timezone).slice(0, 7);
    const imageKey = `${storyPrefix(couple._id)}${month}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  async createVideoUploadUrl(couple: CoupleDoc, mimeType: string, sizeBytes: number) {
    return createStoryVideoUploadUrl(storyVideoPrefix('couples', couple._id.toString()),
      getLocalDate(new Date(), couple.timezone).slice(0, 7), mimeType, sizeBytes);
  },

  /**
   * `notify: false` when the caller sends its own push about the same thing (CP3: "đã làm xong" replaces "vừa đăng một
   * bài viết mới", so the partner gets one notification, not two).
   * `sharedPhotos`: internal callers only (never from the request body): also accept photos of these features of the
   * same couple (CP6: the two moment photos).
   */
  /** Internal callers validate all media before reserving a durable source completion. */
  async validateCreate(couple: CoupleDoc, userId: string, input: StoryInput): Promise<void> {
    const content = normalize(couple, input);
    await validatePhotos(couple, userId, content.photos, new Set());
    await validateStoryVideos(storyVideoPrefix('couples', couple._id.toString()), content.videos);
  },

  async create(
    couple: CoupleDoc,
    userId: string,
    input: StoryInput,
    opts: { notify?: boolean; sharedPhotos?: SharedPhotoFeature[]; reservedId?: Types.ObjectId } = {},
  ): Promise<StoryView> {
    const content = normalize(couple, input);
    await validatePhotos(couple, userId, content.photos, new Set(), opts.sharedPhotos);
    await validateStoryVideos(storyVideoPrefix('couples', couple._id.toString()), content.videos);
    const story = opts.reservedId
      ? await storyRepository.createReserved(opts.reservedId, { ...content, coupleId: couple._id, authorId: new Types.ObjectId(userId) })
      : await storyRepository.create({ ...content, coupleId: couple._id, authorId: new Types.ObjectId(userId) });
    await realtimeAudience.couple(couple._id, ['stories']);
    logger.info('Story created', { coupleId: couple._id.toString(), userId, storyId: story._id.toString(), photos: content.photos.length });
    // Never the post's words or photos on the lock screen.
    if (opts.notify !== false) {
      await notificationService.toPartner(couple, userId, {
        type: 'couple_story',
        entityId: story._id, eventKey: String(story._id),
        target: { kind: 'story', id: String(story._id) },
        push: { body: (name) => `${name} vừa đăng một bài viết mới`, url: `/stories/${story._id.toString()}`, tag: `story:${story._id.toString()}` },
      });
    }
    return toView(story, userId, await memberNames(couple));
  },

  /** Author-only. Marks the post as edited (unless nothing changed) and removes dropped photos from storage. */
  async update(couple: CoupleDoc, userId: string, id: string, input: StoryInput): Promise<StoryView> {
    const current = await requireOwnStory(couple, userId, id);
    const content = normalize(couple, input, current.videos ?? []);
    const names = await memberNames(couple);
    if (sameContent(content, current)) return toView(current, userId, names);

    await validatePhotos(couple, userId, content.photos, new Set(current.photos.map((p) => p.key)));
    await validateStoryVideos(storyVideoPrefix('couples', couple._id.toString()), content.videos, current.videos);
    const updated = await storyRepository.updateContent(couple._id, id, new Types.ObjectId(userId), content);
    if (!updated) throw Errors.notFound('Bài viết không tồn tại hoặc đã bị xóa');

    await realtimeAudience.couple(couple._id, ['stories']);
    // Removed videos deliberately stay in storage: other posts may reference the same key, as with soft deletion.
    const kept = new Set(content.photos.map((p) => p.key));
    // Only the story's own photos are deleted; shared ones (a moment's photos) belong to their feature.
    const own = storyPrefix(couple._id);
    const dropped = current.photos.filter((p) => !kept.has(p.key) && p.key.startsWith(own));
    await Promise.all(
      dropped.map((p) =>
        getStorage()
          .deleteObject(p.key)
          .catch((err: Error) => logger.warn('Could not delete dropped story photo', { key: p.key, message: err.message })),
      ),
    );
    logger.info('Story edited', { coupleId: couple._id.toString(), userId, storyId: id, droppedPhotos: dropped.length });
    return toView(updated, userId, names);
  },

  /** Author-only soft delete. Photos stay in storage so an admin can restore the post. */
  async remove(couple: CoupleDoc, userId: string, id: string): Promise<void> {
    await requireOwnStory(couple, userId, id);
    const deleted = await storyRepository.softDelete(couple._id, id, new Types.ObjectId(userId));
    if (!deleted) throw Errors.notFound('Bài viết không tồn tại hoặc đã bị xóa');
    await realtimeAudience.couple(couple._id, ['stories', 'moments', 'bucket']);
    logger.warn('Story deleted (soft)', { coupleId: couple._id.toString(), userId, storyId: id });
  },

  async react(couple: CoupleDoc, userId: string, id: string, type: ReactionType | null): Promise<StoryView> {
    const story = await storyRepository.setReaction(couple._id, id, userId, type);
    if (!story) throw Errors.notFound('Bài viết không tồn tại hoặc đã bị xóa');
    await realtimeAudience.couple(couple._id, ['stories']);
    return toView(story, userId, await memberNames(couple));
  },

  async listCommentsPage(couple: CoupleDoc, userId: string, storyId: string, input: { limit: number; cursor?: string }) {
    const scope = `story-comments:${couple._id}:${storyId.toLowerCase()}`;
    const before = decodeHistoryCursor(input.cursor, scope);
    const story = await requireStory(couple, storyId);
    const [rows, names] = await Promise.all([
      storyCommentRepository.listPage(couple._id, story._id, input.limit, before), memberNames(couple),
    ]);
    const page = rows.slice(0, input.limit), last = page[page.length - 1];
    return { items: page.map(c => toCommentView(c, userId, names)), nextCursor: rows.length > input.limit && last
      ? encodeHistoryCursor(scope, { createdAt: last.createdAt, id: last._id.toString() }) : null };
  },

  async listComments(couple: CoupleDoc, userId: string, storyId: string): Promise<CommentView[]> {
    const story = await requireStory(couple, storyId);
    const [comments, names] = await Promise.all([storyCommentRepository.list(couple._id, story._id), memberNames(couple)]);
    return comments.map((c) => toCommentView(c, userId, names));
  },

  async addComment(couple: CoupleDoc, userId: string, storyId: string, body: string): Promise<CommentView> {
    const story = await requireStory(couple, storyId);
    const text = body.trim();
    if (!text) throw Errors.badRequest('Bình luận không được để trống');
    const comment = await storyCommentRepository.create({
      coupleId: couple._id,
      storyId: story._id,
      authorId: new Types.ObjectId(userId),
      body: text,
    });
    await realtimeAudience.couple(couple._id, ['stories']);
    await storyRepository.incCommentCount(couple._id, story._id, 1);
    await realtimeAudience.couple(couple._id, ['stories']);
    // Never the comment's words. "your post" when the partner is the author, else a comment under the commenter's own post.
    const partnerIsAuthor = story.authorId.toString() !== userId;
    await notificationService.toPartner(couple, userId, {
      type: 'couple_comment',
      entityId: story._id, eventKey: String(comment._id),
      target: { kind: 'story', id: String(story._id), commentId: String(comment._id) },
      push: {
        body: (name) => (partnerIsAuthor ? `${name} đã bình luận về bài viết của bạn` : `${name} đã bình luận thêm trong bài viết của mình`),
        url: `/stories/${story._id.toString()}`,
        tag: `story:${story._id.toString()}`,
      },
    });
    return toCommentView(comment, userId, await memberNames(couple));
  },

  /** Comment author only. */
  async deleteComment(couple: CoupleDoc, userId: string, storyId: string, commentId: string): Promise<void> {
    const story = await requireStory(couple, storyId);
    const comment = await storyCommentRepository.findById(couple._id, story._id, commentId);
    if (!comment) throw Errors.notFound('Bình luận không tồn tại');
    if (comment.authorId.toString() !== userId) throw Errors.forbidden('Bạn chỉ xóa được bình luận của mình');
    const deleted = await storyCommentRepository.softDelete(couple._id, comment._id, new Types.ObjectId(userId));
    if (!deleted) throw Errors.notFound('Bình luận không tồn tại');
    await realtimeAudience.couple(couple._id, ['stories']);
    await storyRepository.incCommentCount(couple._id, story._id, -1);
    await realtimeAudience.couple(couple._id, ['stories']);
    logger.info('Story comment deleted', { coupleId: couple._id.toString(), userId, storyId, commentId });
  },

  /** Partner's posts + comments since the caller last opened the feed (nav badge). */
  async unreadCount(couple: CoupleDoc, userId: string) {
    const partner = partnerOf(couple, userId);
    if (!partner) return { count: 0, stories: 0, comments: 0 };
    const me = await userRepository.findById(userId);
    const since = me?.storiesSeenAt ?? null;
    const [stories, comments] = await Promise.all([
      storyRepository.countByAuthorSince(couple._id, partner, since),
      storyCommentRepository.countByAuthorSince(couple._id, partner, since),
    ]);
    return { count: stories + comments, stories, comments };
  },

  /**
   * Mark the feed as seen now. Returns the PREVIOUS seen time, which the client uses as the
   * baseline for "Mới" badges during this visit (partner posts newer than it are new).
   */
  async markSeen(userId: string): Promise<{ previousSeenAt: string | null }> {
    const me = await userRepository.findById(userId);
    await userRepository.setStoriesSeenAt(userId, new Date());
    // Seen acknowledgements update badges only; refreshing the feed would mark it seen again.
    await realtimeAudience.own(userId, 'couple', ['story-unread']);
    return { previousSeenAt: me?.storiesSeenAt ? me.storiesSeenAt.toISOString() : null };
  },

  /** "Ngày này năm xưa": memories that happened on today's day-month in earlier years. */
  async onThisDay(couple: CoupleDoc, userId: string): Promise<StoryView[]> {
    const today = getLocalDate(new Date(), couple.timezone);
    const [docs, names] = await Promise.all([
      storyRepository.onThisDay(couple._id, today.slice(5), today.slice(0, 4)),
      memberNames(couple),
    ]);
    return Promise.all(docs.map((d) => toView(d, userId, names)));
  },
};
