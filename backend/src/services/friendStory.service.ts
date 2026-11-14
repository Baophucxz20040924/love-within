import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { FriendStoryDoc } from '../models/FriendStory.js';
import { MAX_MENTIONS, type CommentMention, type FriendStoryCommentDoc } from '../models/FriendStoryComment.js';
import { MAX_STORY_PHOTOS, type ReactionType, type StoryPhoto } from '../models/Story.js';
import type { UserDoc } from '../models/User.js';
import { getStorage } from '../integrations/index.js';
import { friendshipRepository, otherOf } from '../repositories/friendship.repository.js';
import { friendBlockRepository, friendHiddenStoryRepository } from '../repositories/friendSafety.repository.js';
import {
  friendStoryCommentRepository,
  friendStoryRepository,
  type FriendStoryContent,
} from '../repositories/friendStory.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { notificationService } from './notification.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';

const invalidateStory = (story: FriendStoryDoc) => (story.hiddenByReportsAt
  ? realtimeAudience.own(story.authorId.toString(), 'friends', ['friend-posts'])
  : realtimeAudience.friendsOf(story.authorId.toString(), ['friend-posts'])).catch(() => {});
import { searchNameOf } from './friends.service.js';
import { profileOf, profileService, type PublicProfile } from './profile.service.js';
import {
  checkVote,
  isPollClosed,
  newPoll,
  pollEdit,
  pollErrors,
  pollView,
  previewIdsOf,
  votersOf,
  VOTERS_LIMIT,
  type FriendPollInput,
  type FriendPollView,
} from './friendPoll.js';
import { STORY_IMAGE_TYPES } from './story.service.js';

export interface FriendStoryInput {
  body: string;
  photos: StoryPhoto[];
  /** BB6. Create: a poll or nothing. Edit: left out = keep the poll as it is; null = remove it; a poll = replace it (only without votes). */
  poll?: FriendPollInput | null;
}

export interface FriendStoryView {
  id: string;
  author: PublicProfile;
  isMine: boolean;
  body: string;
  photos: { key: string; url: string; width: number; height: number }[];
  /** total = everyone's reactions; top = up to 3 most used types (most first). */
  reactions: { mine: ReactionType | null; total: number; top: ReactionType[] };
  commentCount: number;
  /** BB6; null when the post has no poll. */
  poll: FriendPollView | null;
  createdAt: string;
  editedAt: string | null;
}

export interface MentionView {
  userId: string;
  offset: number;
  length: number;
}

export interface FriendCommentView {
  id: string;
  author: PublicProfile;
  isMine: boolean;
  /** Comment author, or the post author (they moderate their own post). */
  canDelete: boolean;
  body: string;
  createdAt: string;
  /** Root comment this reply belongs to; null for a root comment. */
  parentId: string | null;
  /** "@Tên" spans of `body` to show bold with a link. People blocked either way with the viewer are left out (plain text). */
  mentions: MentionView[];
}

/** GET comments: root comments, oldest first, each with its replies (one level). */
export interface FriendCommentThreadView extends FriendCommentView {
  replies: FriendCommentView[];
}

export interface FriendCommentInput {
  body: string;
  parentId?: string;
  mentions?: MentionView[];
}

type Profiles = Map<string, PublicProfile>;

/** What the views of some posts need: author (and voter) photos, and who the viewer blocks either way (poll voters). */
interface ViewCtx {
  profiles: Profiles;
  blocked: ReadonlySet<string>;
}

const POST_NOT_FOUND = 'Bài viết không tồn tại hoặc đã bị xóa';
const COMMENT_NOT_FOUND = 'Bình luận không tồn tại';
const NOT_MEMBER = 'Không tìm thấy người này trong Hội bạn bè';
const MENTIONABLE_LIMIT = 10;
/** Same answer whether the person cannot see the post or blocks / is blocked by the writer: a block is never revealed. */
const mentionNotAllowed = () => new AppError(400, 'MENTION_NOT_ALLOWED', 'Không nhắc được tên người này trong bài viết này');
const badMention = () => new AppError(400, 'BAD_MENTION', 'Nhắc tên không hợp lệ. Hãy chọn lại tên trong danh sách nhé.');

const toObjectIds = (ids: Iterable<string>) => [...ids].map((id) => new Types.ObjectId(id));

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function storyPrefix(userId: Types.ObjectId): string {
  return `friends/${userId.toString()}/stories/`;
}

async function toView(s: FriendStoryDoc, userId: string, ctx: ViewCtx): Promise<FriendStoryView> {
  const { profiles } = ctx;
  const storage = getStorage();
  const photos = await Promise.all(
    s.photos.map(async (p) => ({
      key: p.key,
      width: p.width,
      height: p.height,
      url: (await storage.getDownloadUrl(p.key, { cacheable: true })).url,
    })),
  );
  let mine: ReactionType | null = null;
  let total = 0;
  const counts = new Map<ReactionType, number>();
  for (const [uid, type] of s.reactions ?? new Map<string, ReactionType>()) {
    total += 1;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (uid === userId) mine = type;
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  return {
    id: s._id.toString(),
    author: profileOf(profiles, s.authorId),
    isMine: s.authorId.toString() === userId,
    body: s.body,
    photos,
    reactions: { mine, total, top },
    commentCount: s.commentCount ?? 0,
    poll: s.poll ? pollView(s.poll, userId, profiles, ctx.blocked) : null,
    createdAt: s.createdAt.toISOString(),
    editedAt: s.editedAt ? s.editedAt.toISOString() : null,
  };
}

/** One query for the blocks (only when a poll is shown) and one for every face on these posts. */
async function viewCtx(me: UserDoc, stories: FriendStoryDoc[]): Promise<ViewCtx> {
  const blocked = stories.some((s) => s.poll) ? await friendBlockRepository.blockedIdsFor(me._id) : new Set<string>();
  const profiles = await profileService.load([...stories.map((s) => s.authorId), ...previewIdsOf(stories, blocked)]);
  return { profiles, blocked };
}

async function viewOne(me: UserDoc, s: FriendStoryDoc): Promise<FriendStoryView> {
  return toView(s, me._id.toString(), await viewCtx(me, [s]));
}

function toCommentView(
  c: FriendStoryCommentDoc,
  userId: string,
  storyAuthorId: string,
  profiles: Profiles,
  blocked: ReadonlySet<string>,
): FriendCommentView {
  const authorId = c.authorId.toString();
  return {
    id: c._id.toString(),
    author: profileOf(profiles, c.authorId),
    isMine: authorId === userId,
    canDelete: authorId === userId || storyAuthorId === userId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    parentId: c.parentId ? c.parentId.toString() : null,
    mentions: (c.mentions ?? [])
      .filter((m) => !blocked.has(m.userId.toString()))
      .map((m) => ({ userId: m.userId.toString(), offset: m.offset, length: m.length })),
  };
}

/** The viewer may see this comment: their own, or not hidden after reports and not written by someone blocked either way. */
function commentVisibleTo(me: UserDoc, c: Pick<FriendStoryCommentDoc, 'authorId' | 'hiddenByReportsAt'>, blocked: ReadonlySet<string>): boolean {
  return c.authorId.equals(me._id) || (!c.hiddenByReportsAt && !blocked.has(c.authorId.toString()));
}

/** Someone other than the caller can see the post: its author, or a current friend of the author (and not hidden after reports). */
async function canSeeStory(userId: Types.ObjectId, story: FriendStoryDoc): Promise<boolean> {
  if (userId.equals(story.authorId)) return true;
  return !story.hiddenByReportsAt && !(await friendBlockRepository.isBlockedBetween(userId, story.authorId)) &&
    (await friendshipRepository.areFriends(userId, story.authorId));
}

/**
 * Mentions of a new comment (BB8): sorted, inside the trimmed body, each starting with "@" followed by the person's name,
 * no overlap, at most 10. The person must be able to see the post and must not block (or be blocked by) the writer.
 */
async function validateMentions(
  story: FriendStoryDoc,
  body: string,
  raw: MentionView[],
  blocked: ReadonlySet<string>,
): Promise<CommentMention[]> {
  if (raw.length === 0) return [];
  if (raw.length > MAX_MENTIONS) throw badMention();
  const sorted = [...raw].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const m of sorted) {
    if (m.length < 2 || m.offset < end || m.offset + m.length > body.length || body[m.offset] !== '@') throw badMention();
    end = m.offset + m.length;
  }
  const ids = [...new Set(sorted.map((m) => m.userId))];
  const profiles = await userRepository.findProfiles(toObjectIds(ids));
  for (const m of sorted) {
    const user = profiles.get(m.userId);
    if (!user || blocked.has(m.userId)) throw mentionNotAllowed();
    if (body.slice(m.offset + 1, m.offset + m.length) !== user.displayName) throw badMention();
  }
  const author = story.authorId.toString();
  const others = ids.filter((id) => id !== author);
  if (others.length > 0) {
    // A post hidden after reports is seen by its author only.
    if (story.hiddenByReportsAt) throw mentionNotAllowed();
    const [rows, authorBlocks] = await Promise.all([
      friendshipRepository.listBetween(story.authorId, others),
      friendBlockRepository.blockedIdsFor(story.authorId),
    ]);
    const friends = new Set(rows.filter((r) => r.status === 'accepted')
      .map((r) => otherOf(r, story.authorId).toString()).filter((id) => !authorBlocks.has(id)));
    if (others.some((id) => !friends.has(id))) throw mentionNotAllowed();
  }
  return sorted.map((m) => ({ userId: new Types.ObjectId(m.userId), offset: m.offset, length: m.length }));
}

/**
 * One notification per person for a new comment, the most specific one: mention, then reply to their comment, then a
 * comment on their post (plan: "ưu tiên mention"). Never the writer. A reply notifies the root comment's author only while
 * they can still see the post.
 */
async function notifyComment(me: UserDoc, story: FriendStoryDoc, comment: FriendStoryCommentDoc, root: FriendStoryCommentDoc | null) {
  const sent = new Set<string>([me._id.toString()]);
  const first = (id: Types.ObjectId) => {
    const key = id.toString();
    if (sent.has(key)) return false;
    sent.add(key);
    return true;
  };
  for (const m of comment.mentions) {
    if (first(m.userId)) {
      await notificationService.emit({ space: 'friends', to: m.userId, type: 'mention', actorId: me._id, entityId: comment._id, postId: story._id });
    }
  }
  if (root && !sent.has(root.authorId.toString()) && (await canSeeStory(root.authorId, story)) && first(root.authorId)) {
    await notificationService.emit({ space: 'friends', to: root.authorId, type: 'comment_reply', actorId: me._id, entityId: root._id, postId: story._id });
  }
  if (first(story.authorId)) {
    await notificationService.emit({ space: 'friends', to: story.authorId, type: 'story_comment', actorId: me._id, entityId: story._id });
  }
}

async function toPage(docs: FriendStoryDoc[], limit: number, me: UserDoc) {
  const page = docs.slice(0, limit);
  const nextCursor = docs.length > limit ? page[page.length - 1]._id.toString() : null;
  const ctx = await viewCtx(me, page);
  const userId = me._id.toString();
  return { items: await Promise.all(page.map((s) => toView(s, userId, ctx))), nextCursor };
}

function normalize(input: FriendStoryInput): FriendStoryContent {
  const body = input.body.trim();
  if (!body && input.photos.length === 0) throw Errors.badRequest('Hãy viết gì đó hoặc thêm ít nhất một ảnh');
  return { body, photos: input.photos.map((p) => ({ key: p.key, width: p.width, height: p.height })) };
}

/** Photos must live under the author's own prefix and really exist in storage. */
async function validatePhotos(me: UserDoc, photos: StoryPhoto[], alreadyAttached: Set<string>): Promise<void> {
  if (photos.length > MAX_STORY_PHOTOS) throw Errors.badRequest(`Tối đa ${MAX_STORY_PHOTOS} ảnh mỗi bài viết`);
  const prefix = storyPrefix(me._id);
  const seen = new Set<string>();
  const toCheck: string[] = [];
  for (const p of photos) {
    if (!p.key.startsWith(prefix) || p.key.includes('..')) {
      logger.warn('Rejected foreign friend-story photo key', { userId: me._id.toString(), key: p.key });
      throw Errors.forbidden('Ảnh không thuộc tài khoản của bạn');
    }
    if (seen.has(p.key)) throw Errors.badRequest('Có ảnh bị trùng');
    seen.add(p.key);
    if (!alreadyAttached.has(p.key)) toCheck.push(p.key);
  }
  const heads = await Promise.all(toCheck.map((key) => getStorage().headObject(key)));
  for (const head of heads) {
    if (!head) throw Errors.badRequest('Có ảnh chưa tải lên xong. Thử đăng lại nhé.');
    if (head.size > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');
  }
}

function sameContent(a: FriendStoryContent, b: FriendStoryDoc): boolean {
  return a.body === b.body && a.photos.length === b.photos.length && a.photos.every((p, i) => p.key === b.photos[i].key);
}

/**
 * A post is visible to its author and the author's current friends, unless it was hidden after reports
 * (then only the author sees it). Anyone else gets 404, the same answer as a deleted post, so strangers
 * cannot probe which posts exist. Blocking removes the friendship, so blocked people fail here too.
 */
async function requireVisible(me: UserDoc, id: string | Types.ObjectId): Promise<FriendStoryDoc> {
  const story = await friendStoryRepository.findById(id);
  if (!story) throw Errors.notFound(POST_NOT_FOUND);
  if (story.authorId.equals(me._id)) return story;
  if (story.hiddenByReportsAt || (await friendBlockRepository.isBlockedBetween(me._id, story.authorId)) ||
      !(await friendshipRepository.areFriends(me._id, story.authorId))) {
    throw Errors.notFound(POST_NOT_FOUND);
  }
  return story;
}

async function requireOwn(me: UserDoc, id: string): Promise<FriendStoryDoc> {
  const story = await requireVisible(me, id);
  if (!story.authorId.equals(me._id)) throw Errors.forbidden('Chỉ người đăng mới sửa hoặc xóa được bài viết này');
  return story;
}

export const friendStoryService = {
  /** My posts + my friends' posts, newest first, without posts I hid. */
  async feed(me: UserDoc, cursor: string | undefined, limit: number) {
    const [friendIds, hidden, blocked] = await Promise.all([
      friendshipRepository.friendIds(me._id),
      friendHiddenStoryRepository.hiddenIds(me._id),
      friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const visibleFriends = friendIds.filter((id) => !blocked.has(id.toString()));
    const docs = await friendStoryRepository.list([me._id, ...visibleFriends], cursor, limit, { viewerId: me._id, excludeIds: hidden });
    return toPage(docs, limit, me);
  },

  /** Posts of one person (profile page): only for that person and their friends. */
  async userStories(me: UserDoc, userId: string, cursor: string | undefined, limit: number) {
    const target = new Types.ObjectId(userId);
    if (!target.equals(me._id)) {
      if (!(await userRepository.isFriendsMember(target)) || (await friendBlockRepository.isBlockedBetween(me._id, target))) {
        throw Errors.notFound(NOT_MEMBER);
      }
      if (!(await friendshipRepository.areFriends(me._id, target))) {
        throw new AppError(403, 'NOT_FRIENDS', 'Kết bạn để xem bài viết của người này');
      }
    }
    const docs = await friendStoryRepository.list([target], cursor, limit, { viewerId: me._id });
    return toPage(docs, limit, me);
  },

  async get(me: UserDoc, id: string): Promise<FriendStoryView> {
    const story = await requireVisible(me, id);
    return viewOne(me, story);
  },

  /** For reports and hiding: the post if the caller may see it (404 otherwise). */
  visibleStory: requireVisible,

  /** For reports: the comment and its post if the caller may see both (404 otherwise). A reply also needs its root comment. */
  async visibleComment(me: UserDoc, commentId: string): Promise<{ comment: FriendStoryCommentDoc; story: FriendStoryDoc }> {
    const comment = await friendStoryCommentRepository.findAnyById(commentId);
    if (!comment) throw Errors.notFound(COMMENT_NOT_FOUND);
    const story = await requireVisible(me, comment.storyId);
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    if (!commentVisibleTo(me, comment, blocked)) throw Errors.notFound(COMMENT_NOT_FOUND);
    if (comment.parentId) {
      const root = await friendStoryCommentRepository.findById(story._id, comment.parentId);
      if (!root || !commentVisibleTo(me, root, blocked)) throw Errors.notFound(COMMENT_NOT_FOUND);
    }
    return { comment, story };
  },

  async createUploadUrl(me: UserDoc, mimeType: string, sizeBytes: number) {
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const month = getLocalDate(new Date(), me.timezone).slice(0, 7);
    const imageKey = `${storyPrefix(me._id)}${month}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  async create(me: UserDoc, input: FriendStoryInput): Promise<FriendStoryView> {
    // The body is the poll's question.
    if (input.poll && !input.body.trim()) throw pollErrors.noQuestion();
    const content = normalize(input);
    const poll = input.poll ? newPoll(input.poll) : null;
    await validatePhotos(me, content.photos, new Set());
    const story = await friendStoryRepository.create({ ...content, authorId: me._id, poll });
    await invalidateStory(story);
    logger.info('Friend story created', {
      userId: me._id.toString(),
      storyId: story._id.toString(),
      photos: content.photos.length,
      pollOptions: poll?.options.length ?? 0,
    });
    return viewOne(me, story);
  },

  /**
   * Author only. Marks the post as edited (unless nothing changed) and removes dropped photos from storage.
   * The poll (BB6): the body may always change; options, "Cho chọn nhiều" and the deadline only while nobody voted, and a
   * poll with votes cannot be removed (409 POLL_LOCKED, also when a vote lands during the edit).
   */
  async update(me: UserDoc, id: string, input: FriendStoryInput): Promise<FriendStoryView> {
    const current = await requireOwn(me, id);
    const pollChange = pollEdit(current.poll, input.poll);
    const finalPoll = pollChange === undefined ? current.poll : pollChange;
    if (finalPoll && !input.body.trim()) throw pollErrors.noQuestion();
    const content = normalize(input);
    const userId = me._id.toString();
    if (sameContent(content, current) && pollChange === undefined) return viewOne(me, current);

    await validatePhotos(me, content.photos, new Set(current.photos.map((p) => p.key)));
    const updated = await friendStoryRepository.updateContent(id, me._id, content, pollChange);
    if (!updated) {
      // Still there: someone voted between the check and the update.
      if (pollChange !== undefined && (await friendStoryRepository.findById(id))) throw pollErrors.locked();
      throw Errors.notFound(POST_NOT_FOUND);
    }
    await invalidateStory(updated);
    // A replaced deadline will be announced again; the old "đã kết thúc" row would be wrong now.
    if (pollChange !== undefined && current.poll?.closedNotifiedAt && !pollChange?.closedNotifiedAt) {
      await notificationService.forgetEntity(updated._id, 'poll_closed');
    }

    const kept = new Set(content.photos.map((p) => p.key));
    const dropped = current.photos.filter((p) => !kept.has(p.key));
    await Promise.all(
      dropped.map((p) =>
        getStorage()
          .deleteObject(p.key)
          .catch((err: Error) => logger.warn('Could not delete dropped friend-story photo', { key: p.key, message: err.message })),
      ),
    );
    const pollAction = pollChange === undefined ? 'kept' : pollChange === null ? 'removed' : current.poll ? 'replaced' : 'added';
    logger.info('Friend story edited', { userId, storyId: id, droppedPhotos: dropped.length, poll: finalPoll || current.poll ? pollAction : 'none' });
    return viewOne(me, updated);
  },

  /** Author only, soft delete. Photos stay in storage so an admin can restore the post. */
  async remove(me: UserDoc, id: string): Promise<void> {
    await requireOwn(me, id);
    const deleted = await friendStoryRepository.softDelete(id, me._id);
    if (!deleted) throw Errors.notFound(POST_NOT_FOUND);
    await invalidateStory(deleted);
    await notificationService.forgetEntity(deleted._id);
    logger.warn('Friend story deleted (soft)', { userId: me._id.toString(), storyId: id });
  },

  async react(me: UserDoc, id: string, type: ReactionType | null): Promise<FriendStoryView> {
    await requireVisible(me, id);
    const userId = me._id.toString();
    const story = await friendStoryRepository.setReaction(id, userId, type);
    if (!story) throw Errors.notFound(POST_NOT_FOUND);
    await invalidateStory(story);
    // Removing a reaction keeps the notification (like Facebook); only new reactions notify.
    if (type) await notificationService.emit({ space: 'friends', to: story.authorId, type: 'story_reaction', actorId: me._id, entityId: story._id });
    return viewOne(me, story);
  },

  /**
   * BB6: choose (or change to) `optionIds` in the post's poll; anyone who may see the post, the author too. One vote per
   * person, written atomically on the person's own key. 404 if the post cannot be seen or has no poll, 409 POLL_CLOSED
   * after the deadline, 400 BAD_OPTION / SINGLE_CHOICE for options that are not in the poll or too many. No notification.
   */
  async vote(me: UserDoc, id: string, optionIds: string[]): Promise<FriendStoryView> {
    const story = await requireVisible(me, id);
    const now = new Date();
    const ids = checkVote(story, optionIds, now);
    const updated = await friendStoryRepository.vote(id, me._id.toString(), ids, now);
    if (!updated) {
      // Changed meanwhile (deleted, closed, options replaced): answer for the state it is in now.
      checkVote(await requireVisible(me, id), ids);
      throw pollErrors.badOption();
    }
    await invalidateStory(updated);
    return viewOne(me, updated);
  },

  /** BB6: take my vote back while the poll is open (no vote: nothing changes). */
  async unvote(me: UserDoc, id: string): Promise<FriendStoryView> {
    const story = await requireVisible(me, id);
    if (!story.poll) throw pollErrors.notFound();
    const now = new Date();
    if (isPollClosed(story.poll, now)) throw pollErrors.closed();
    const updated = await friendStoryRepository.unvote(id, me._id.toString(), now);
    if (!updated) {
      const again = await requireVisible(me, id);
      if (!again.poll) throw pollErrors.notFound();
      throw pollErrors.closed();
    }
    await invalidateStory(updated);
    return viewOne(me, updated);
  },

  /**
   * BB6: who chose one option, newest first, at most 500. People blocked either way with me are left out (the count still
   * includes them, like the bars).
   */
  async pollVoters(me: UserDoc, id: string, optionId: string): Promise<{ option: string; count: number; items: PublicProfile[] }> {
    const story = await requireVisible(me, id);
    const poll = story.poll;
    if (!poll) throw pollErrors.notFound();
    if (!poll.options.some((o) => o.id === optionId)) throw pollErrors.badOption();
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    const all = votersOf(poll, optionId);
    const shown = all.filter((v) => !blocked.has(v)).slice(0, VOTERS_LIMIT);
    const profiles = await profileService.load(toObjectIds(shown));
    return { option: optionId, count: all.length, items: shown.map((v) => profileOf(profiles, v)) };
  },

  /**
   * Root comments oldest first, each with its replies (one level), at most 500 comments in all. Without people blocked
   * either way and without comments hidden after reports (except my own). A reply whose root I cannot see is left out too.
   */
  async listComments(me: UserDoc, storyId: string): Promise<FriendCommentThreadView[]> {
    const story = await requireVisible(me, storyId);
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    const comments = await friendStoryCommentRepository.list(story._id, me._id, toObjectIds(blocked));
    const profiles = await profileService.load(comments.map((c) => c.authorId));
    const userId = me._id.toString();
    const author = story.authorId.toString();
    const roots: FriendCommentThreadView[] = [];
    const byId = new Map<string, FriendCommentThreadView>();
    // Oldest first: a root always comes before its replies.
    for (const c of comments) {
      const view = toCommentView(c, userId, author, profiles, blocked);
      if (!c.parentId) {
        const thread = { ...view, replies: [] };
        roots.push(thread);
        byId.set(thread.id, thread);
      } else {
        byId.get(c.parentId.toString())?.replies.push(view);
      }
    }
    return roots;
  },

  /**
   * New comment, or a reply with `parentId`. Replying to a reply attaches to its root (one level). Mentions are checked by
   * validateMentions. Notifies once per person (mention > reply > comment on my post).
   */
  async addComment(me: UserDoc, storyId: string, input: FriendCommentInput): Promise<FriendCommentView> {
    const story = await requireVisible(me, storyId);
    const text = input.body.trim();
    if (!text) throw Errors.badRequest('Bình luận không được để trống');
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);

    let root: FriendStoryCommentDoc | null = null;
    if (input.parentId) {
      const parent = await friendStoryCommentRepository.findById(story._id, input.parentId);
      if (!parent || !commentVisibleTo(me, parent, blocked)) throw Errors.notFound('Bình luận bạn trả lời không còn nữa');
      root = parent.parentId ? await friendStoryCommentRepository.findById(story._id, parent.parentId) : parent;
      if (!root || !commentVisibleTo(me, root, blocked)) throw Errors.notFound('Bình luận bạn trả lời không còn nữa');
    }
    const mentions = await validateMentions(story, text, input.mentions ?? [], blocked);

    const comment = await friendStoryCommentRepository.create({
      storyId: story._id,
      authorId: me._id,
      parentId: root?._id ?? null,
      body: text,
      mentions,
    });
    await invalidateStory(story);
    await friendStoryRepository.incCommentCount(story._id, 1);
    await invalidateStory(story);
    await notifyComment(me, story, comment, root);
    return toCommentView(comment, me._id.toString(), story.authorId.toString(), await profileService.load([me._id]), blocked);
  },

  /**
   * Comment author, or the post author. Deleting a root comment deletes its replies too; `removed` = how many comments
   * left the count (the app lowers the post's comment count by it).
   */
  async deleteComment(me: UserDoc, storyId: string, commentId: string): Promise<{ removed: number }> {
    const story = await requireVisible(me, storyId);
    const comment = await friendStoryCommentRepository.findById(story._id, commentId);
    if (!comment) throw Errors.notFound(COMMENT_NOT_FOUND);
    if (!comment.authorId.equals(me._id) && !story.authorId.equals(me._id)) {
      throw Errors.forbidden('Bạn chỉ xóa được bình luận của mình hoặc trên bài của mình');
    }
    const deleted = await friendStoryCommentRepository.softDelete(story._id, comment._id);
    if (!deleted) throw Errors.notFound(COMMENT_NOT_FOUND);
    await invalidateStory(story);
    let removed = 1;
    const gone = [deleted._id];
    if (!deleted.parentId) {
      const replies = await friendStoryCommentRepository.softDeleteReplies(story._id, deleted._id);
      removed += replies.removed;
      gone.push(...replies.ids);
    }
    await friendStoryRepository.decCommentCount(story._id, removed);
    await invalidateStory(story);
    // Replies to these comments and mentions in them are no longer useful.
    await notificationService.forgetEntities(gone);
    logger.info('Friend story comment deleted', { userId: me._id.toString(), storyId, commentId, removed });
    return { removed };
  },

  /**
   * "@" picker (BB8): up to 10 people, the post author first, then my friends who can also see the post (friends of the
   * author), A→Z, matching `q` without diacritics. Never me, never people blocked either way. Nobody for a post hidden
   * after reports (only its author sees it).
   */
  async mentionable(me: UserDoc, storyId: string, q: string): Promise<PublicProfile[]> {
    const story = await requireVisible(me, storyId);
    if (story.hiddenByReportsAt) return [];
    const isAuthor = story.authorId.equals(me._id);
    const [mine, blocked] = await Promise.all([friendshipRepository.friendIds(me._id), friendBlockRepository.blockedIdsFor(me._id)]);
    let ids = mine;
    if (!isAuthor) {
      const [authorFriends, authorBlocks] = await Promise.all([
        friendshipRepository.friendIds(story.authorId),
        friendBlockRepository.blockedIdsFor(story.authorId),
      ]);
      const theirs = new Set(authorFriends.map((id) => id.toString()).filter((id) => !authorBlocks.has(id)));
      ids = mine.filter((id) => theirs.has(id.toString()));
    }
    ids = ids.filter((id) => !blocked.has(id.toString()) && !id.equals(me._id) && !id.equals(story.authorId));
    const name = searchNameOf(q);
    const others = await userRepository.findMembersByName(ids, escapeRegex(name), MENTIONABLE_LIMIT);
    let people: { _id: Types.ObjectId; displayName: string; avatarKey?: string | null }[] = others;
    if (!isAuthor && !blocked.has(story.authorId.toString())) {
      const author = await userRepository.findById(story.authorId);
      if (author && (!name || (author.friendsSearchName ?? searchNameOf(author.displayName)).includes(name))) {
        people = [author, ...others].slice(0, MENTIONABLE_LIMIT);
      }
    }
    return Promise.all(people.map((u) => profileService.of(u)));
  },
};
