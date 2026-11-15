import { Types } from 'mongoose';
import { createHash } from 'node:crypto';

export function storyCreationFingerprint(input: StoryContent & { coupleId: Types.ObjectId; authorId: Types.ObjectId }): string {
  return createHash('sha256').update(JSON.stringify({ coupleId: String(input.coupleId), authorId: String(input.authorId),
    body: input.body, mood: input.mood, happenedOn: input.happenedOn,
    photos: input.photos.map(p => ({ key: p.key, width: p.width, height: p.height })), videos: input.videos ?? [] })).digest('hex');
}
import { Story, type Mood, type ReactionType, type StoryDoc, type StoryPhoto, type StoryVideo } from '../models/Story.js';
import { StoryComment, type StoryCommentDoc } from '../models/StoryComment.js';

export interface StoryContent {
  body: string;
  mood: Mood | null;
  happenedOn: string;
  photos: StoryPhoto[];
  /** Optional for existing internal moment/bucket callers; services resolve edit omission before persistence. */
  videos?: StoryVideo[];
}

const alive = { deletedAt: null };

/** Every query is scoped by coupleId (Requirement 3.4). Edits and deletes also require authorId. */
export const storyRepository = {
  create(input: StoryContent & { coupleId: Types.ObjectId; authorId: Types.ObjectId }): Promise<StoryDoc> {
    return Story.create(input);
  },

  async createReserved(id: Types.ObjectId, input: StoryContent & { coupleId: Types.ObjectId; authorId: Types.ObjectId }): Promise<StoryDoc> {
    const creationFingerprint = storyCreationFingerprint(input);
    try { return await Story.create({ ...input, _id: id, creationFingerprint }); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      return Story.findOne({ _id: id, coupleId: input.coupleId, authorId: input.authorId, creationFingerprint }).orFail().exec();
    }
  },

  /** Includes soft-deleted posts: a completed source must never recreate a deleted memory. */
  findReserved(coupleId: Types.ObjectId, id: string, authorId: Types.ObjectId): Promise<StoryDoc | null> {
    return Story.findOne({ _id: id, coupleId, authorId }).exec();
  },

  findById(coupleId: Types.ObjectId, id: string): Promise<StoryDoc | null> {
    return Story.findOne({ _id: id, coupleId, ...alive }).exec();
  },

  /** Newest first. Fetches limit + 1 so the caller knows whether another page exists. */
  list(coupleId: Types.ObjectId, cursor: string | undefined, limit: number): Promise<StoryDoc[]> {
    const filter: Record<string, unknown> = { coupleId, ...alive };
    if (cursor) filter._id = { $lt: new Types.ObjectId(cursor) };
    return Story.find(filter).sort({ _id: -1 }).limit(limit + 1).exec();
  },

  /** Only the author's own post matches, so a partner can never edit it. */
  updateContent(coupleId: Types.ObjectId, id: string, authorId: Types.ObjectId, content: StoryContent): Promise<StoryDoc | null> {
    return Story.findOneAndUpdate(
      { _id: id, coupleId, authorId, ...alive },
      { $set: { ...content, editedAt: new Date() } },
      { new: true },
    ).exec();
  },

  softDelete(coupleId: Types.ObjectId, id: string, authorId: Types.ObjectId): Promise<StoryDoc | null> {
    return Story.findOneAndUpdate({ _id: id, coupleId, authorId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  /** Atomic per-user set/unset (Map path), so two devices can't create duplicate reactions. */
  setReaction(coupleId: Types.ObjectId, id: string, userId: string, type: ReactionType | null): Promise<StoryDoc | null> {
    const update = type ? { $set: { [`reactions.${userId}`]: type } } : { $unset: { [`reactions.${userId}`]: '' } };
    return Story.findOneAndUpdate({ _id: id, coupleId, ...alive }, update, { new: true }).exec();
  },

  async incCommentCount(coupleId: Types.ObjectId, id: Types.ObjectId, delta: 1 | -1): Promise<void> {
    const filter: Record<string, unknown> = { _id: id, coupleId };
    if (delta < 0) filter.commentCount = { $gt: 0 };
    await Story.updateOne(filter, { $inc: { commentCount: delta } }).exec();
  },

  /** Same day-month in earlier years ("Ngày này năm xưa"). */
  onThisDay(coupleId: Types.ObjectId, monthDay: string, year: string): Promise<StoryDoc[]> {
    return Story.find({ coupleId, ...alive, happenedOn: { $regex: `-${monthDay}$`, $lt: year } })
      .sort({ happenedOn: -1 })
      .limit(5)
      .exec();
  },

  countByAuthorSince(coupleId: Types.ObjectId, authorId: Types.ObjectId, since: Date | null): Promise<number> {
    const filter: Record<string, unknown> = { coupleId, authorId, ...alive };
    if (since) filter.createdAt = { $gt: since };
    return Story.countDocuments(filter).exec();
  },

  /** Which of these posts still exist (not deleted), e.g. for the bucket list's "Xem kỷ niệm" links. */
  async aliveIds(coupleId: Types.ObjectId, ids: Types.ObjectId[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await Story.find({ coupleId, ...alive, _id: { $in: ids } }).select('_id').lean().exec();
    return new Set(rows.map((r) => r._id.toString()));
  },
};

export const storyCommentRepository = {
  create(input: { coupleId: Types.ObjectId; storyId: Types.ObjectId; authorId: Types.ObjectId; body: string }): Promise<StoryCommentDoc> {
    return StoryComment.create(input);
  },

  list(coupleId: Types.ObjectId, storyId: Types.ObjectId): Promise<StoryCommentDoc[]> {
    return StoryComment.find({ coupleId, storyId, ...alive }).sort({ createdAt: 1 }).limit(500).exec();
  },

  findById(coupleId: Types.ObjectId, storyId: Types.ObjectId, id: string): Promise<StoryCommentDoc | null> {
    return StoryComment.findOne({ _id: id, coupleId, storyId, ...alive }).exec();
  },

  softDelete(coupleId: Types.ObjectId, id: Types.ObjectId, authorId: Types.ObjectId): Promise<StoryCommentDoc | null> {
    return StoryComment.findOneAndUpdate({ _id: id, coupleId, authorId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  /** Comments by `authorId` on stories that are still visible. */
  async countByAuthorSince(coupleId: Types.ObjectId, authorId: Types.ObjectId, since: Date | null): Promise<number> {
    const filter: Record<string, unknown> = { coupleId, authorId, ...alive };
    if (since) filter.createdAt = { $gt: since };
    const comments = await StoryComment.find(filter).select('storyId').limit(500).lean().exec();
    if (comments.length === 0) return 0;
    const storyIds = [...new Set(comments.map((c) => c.storyId.toString()))];
    const visible = await Story.find({ coupleId, ...alive, _id: { $in: storyIds } }).select('_id').lean().exec();
    const visibleIds = new Set(visible.map((s) => s._id.toString()));
    return comments.filter((c) => visibleIds.has(c.storyId.toString())).length;
  },
};
