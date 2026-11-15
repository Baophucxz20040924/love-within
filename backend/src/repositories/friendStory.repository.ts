import { Types } from 'mongoose';
import { FriendStory, type FriendStoryDoc, type PollOption } from '../models/FriendStory.js';
import { FriendStoryComment, type CommentMention, type FriendStoryCommentDoc } from '../models/FriendStoryComment.js';
import type { ReactionType, StoryPhoto } from '../models/Story.js';

export interface FriendStoryContent {
  body: string;
  photos: StoryPhoto[];
  mentions: CommentMention[];
}

/** A poll as written on create or when the author replaces it (votes always start empty). */
export interface NewPoll {
  options: PollOption[];
  multi: boolean;
  endsAt: Date | null;
  closedNotifiedAt: Date | null;
}

/** No vote yet: the only state in which the author may change or remove the poll (one condition, no read-then-write). */
const noVotes = { $expr: { $eq: [{ $size: { $objectToArray: { $ifNull: ['$poll.votes', {}] } } }, 0] } };

/** Poll still open at `now` (no deadline, or the deadline is later). */
const pollOpenAt = (now: Date) => ({ $or: [{ 'poll.endsAt': null }, { 'poll.endsAt': { $gt: now } }] });

const storedPoll = (p: NewPoll | null) => (p ? { ...p, votes: {} } : null);

/** Who is looking, so posts hidden after reports stay visible to their author only. */
export interface FeedViewer {
  viewerId: Types.ObjectId;
  /** Posts the viewer hid from their own feed. */
  excludeIds?: Types.ObjectId[];
}

const alive = { deletedAt: null };

/** Visible to the viewer: not hidden after reports, unless the viewer wrote it. */
const notHiddenFor = (viewerId: Types.ObjectId) => ({ $or: [{ hiddenByReportsAt: null }, { authorId: viewerId }] });

/**
 * Friends-space posts. Visibility (author or the author's friends) is checked by friendStoryService
 * before any read or reaction; edits and deletes also require authorId here.
 */
export const friendStoryRepository = {
  create(input: FriendStoryContent & { authorId: Types.ObjectId; poll: NewPoll | null }): Promise<FriendStoryDoc> {
    return FriendStory.create({ ...input, poll: storedPoll(input.poll) });
  },

  findById(id: string | Types.ObjectId): Promise<FriendStoryDoc | null> {
    return FriendStory.findOne({ _id: id, ...alive }).exec();
  },

  /** Newest first among `authorIds`. Fetches limit + 1 so the caller knows whether another page exists. */
  list(authorIds: Types.ObjectId[], cursor: string | undefined, limit: number, view: FeedViewer): Promise<FriendStoryDoc[]> {
    const filter: Record<string, unknown> = { authorId: { $in: authorIds }, ...alive, ...notHiddenFor(view.viewerId) };
    const idFilter: Record<string, unknown> = {};
    if (view.excludeIds?.length) idFilter.$nin = view.excludeIds;
    if (cursor) idFilter.$lt = new Types.ObjectId(cursor);
    if (Object.keys(idFilter).length) filter._id = idFilter;
    return FriendStory.find(filter).sort({ _id: -1 }).limit(limit + 1).exec();
  },

  /** The caller's own posts among `ids` (body only), for notification excerpts. */
  findOwnByIds(authorId: Types.ObjectId, ids: Types.ObjectId[]): Promise<{ _id: Types.ObjectId; body: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return FriendStory.find({ _id: { $in: ids }, authorId, ...alive })
      .select('body')
      .lean<{ _id: Types.ObjectId; body: string }[]>()
      .exec();
  },

  /**
   * Body and photos; with `poll` (a new poll or null to remove it) only while nobody has voted, checked in the same update,
   * so a vote landing at the same moment wins and the edit returns null. Without `poll` the votes are never touched.
   */
  updateContent(id: string, authorId: Types.ObjectId, content: FriendStoryContent, revision: number, poll?: NewPoll | null): Promise<FriendStoryDoc | null> {
    const filter: Record<string, unknown> = {
      _id: id, authorId, ...alive,
      ...(revision === 0 ? { $or: [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] } : { contentRevision: revision }),
    };
    const set: Record<string, unknown> = { ...content, editedAt: new Date() };
    if (poll !== undefined) {
      Object.assign(filter, noVotes);
      set.poll = storedPoll(poll);
    }
    return FriendStory.findOneAndUpdate(filter, { $set: set, $inc: { contentRevision: 1 } }, { new: true }).exec();
  },

  /**
   * Set my choice (replaces an earlier one), atomically on my own key: two taps at once still leave one vote. The filter
   * checks again that the poll is open and still has every chosen option (an edit may have replaced it meanwhile).
   */
  vote(id: string, userId: string, optionIds: string[], now: Date): Promise<FriendStoryDoc | null> {
    return FriendStory.findOneAndUpdate(
      { _id: id, ...alive, 'poll.options.id': { $all: optionIds }, ...pollOpenAt(now) },
      { $set: { [`poll.votes.${userId}`]: optionIds } },
      { new: true },
    ).exec();
  },

  /** Remove my vote while the poll is open (no vote: no change, still returns the post). */
  unvote(id: string, userId: string, now: Date): Promise<FriendStoryDoc | null> {
    return FriendStory.findOneAndUpdate(
      { _id: id, ...alive, poll: { $ne: null }, ...pollOpenAt(now) },
      { $unset: { [`poll.votes.${userId}`]: '' } },
      { new: true },
    ).exec();
  },

  /** Job polls.closed: live posts whose poll deadline has passed and whose author was not told yet (oldest deadline first). */
  async listPollsToAnnounce(now: Date, limit: number): Promise<Types.ObjectId[]> {
    const rows = await FriendStory.find({ 'poll.closedNotifiedAt': null, 'poll.endsAt': { $type: 'date', $lte: now }, ...alive })
      .sort({ 'poll.endsAt': 1 })
      .limit(limit)
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return rows.map((r) => r._id);
  },

  /** Flag "author told" once: only the run whose update matched delivers (pattern a of scheduler.service.ts). */
  markPollClosedNotified(id: Types.ObjectId, now: Date): Promise<FriendStoryDoc | null> {
    return FriendStory.findOneAndUpdate(
      { _id: id, ...alive, 'poll.closedNotifiedAt': null, 'poll.endsAt': { $type: 'date', $lte: now } },
      { $set: { 'poll.closedNotifiedAt': now } },
      { new: true },
    ).exec();
  },

  softDelete(id: string, authorId: Types.ObjectId): Promise<FriendStoryDoc | null> {
    return FriendStory.findOneAndUpdate({ _id: id, authorId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  /** Atomic per-user set/unset (Map path), so two devices can't create duplicate reactions. */
  setReaction(id: string, userId: string, type: ReactionType | null): Promise<FriendStoryDoc | null> {
    const update = type ? { $set: { [`reactions.${userId}`]: type } } : { $unset: { [`reactions.${userId}`]: '' } };
    return FriendStory.findOneAndUpdate({ _id: id, ...alive }, update, { new: true }).exec();
  },

  async incCommentCount(id: Types.ObjectId, delta: 1 | -1): Promise<void> {
    const filter: Record<string, unknown> = { _id: id };
    if (delta < 0) filter.commentCount = { $gt: 0 };
    await FriendStory.updateOne(filter, { $inc: { commentCount: delta } }).exec();
  },

  /** Lower the count by `n` (a root comment and its replies), never below 0. Pipeline update through the driver. */
  async decCommentCount(id: Types.ObjectId, n: number): Promise<void> {
    if (n <= 0) return;
    await FriendStory.collection.updateOne({ _id: id }, [
      { $set: { commentCount: { $max: [0, { $subtract: [{ $ifNull: ['$commentCount', 0] }, n] }] } } },
    ]);
  },

  /** Author and report state of live posts (notification filtering). */
  findAliveByIds(ids: Types.ObjectId[]): Promise<{ _id: Types.ObjectId; authorId: Types.ObjectId; hiddenByReportsAt: Date | null }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return FriendStory.find({ _id: { $in: ids }, ...alive })
      .select('authorId hiddenByReportsAt')
      .lean<{ _id: Types.ObjectId; authorId: Types.ObjectId; hiddenByReportsAt: Date | null }[]>()
      .exec();
  },

  /** Returns true the first time (the caller logs it). */
  async hideByReports(id: Types.ObjectId): Promise<boolean> {
    const res = await FriendStory.updateOne({ _id: id, hiddenByReportsAt: null }, { $set: { hiddenByReportsAt: new Date() } }).exec();
    return res.modifiedCount > 0;
  },
};

/** What notification filtering needs about a comment (never shown as such). */
export interface CommentBrief {
  _id: Types.ObjectId;
  storyId: Types.ObjectId;
  authorId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  body: string;
  hiddenByReportsAt: Date | null;
}

export const friendStoryCommentRepository = {
  create(input: {
    storyId: Types.ObjectId;
    authorId: Types.ObjectId;
    parentId: Types.ObjectId | null;
    body: string;
    mentions: CommentMention[];
  }): Promise<FriendStoryCommentDoc> {
    return FriendStoryComment.create(input);
  },

  /**
   * Oldest first, root comments and replies together (the caller builds the tree), at most 500. Without people blocked
   * either way and without comments hidden after reports (except the viewer's own).
   */
  list(storyId: Types.ObjectId, viewerId: Types.ObjectId, excludeAuthorIds: Types.ObjectId[]): Promise<FriendStoryCommentDoc[]> {
    const filter: Record<string, unknown> = { storyId, ...alive, ...notHiddenFor(viewerId) };
    if (excludeAuthorIds.length) filter.authorId = { $nin: excludeAuthorIds };
    return FriendStoryComment.find(filter).sort({ createdAt: 1 }).limit(500).exec();
  },

  findById(storyId: Types.ObjectId, id: string | Types.ObjectId): Promise<FriendStoryCommentDoc | null> {
    return FriendStoryComment.findOne({ _id: id, storyId, ...alive }).exec();
  },

  /** By id alone (reports name a comment without its post). */
  findAnyById(id: string | Types.ObjectId): Promise<FriendStoryCommentDoc | null> {
    return FriendStoryComment.findOne({ _id: id, ...alive }).exec();
  },

  /** Live comments among `ids` (notification filtering and excerpts). */
  findAliveByIds(ids: Types.ObjectId[]): Promise<CommentBrief[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return FriendStoryComment.find({ _id: { $in: ids }, ...alive })
      .select('storyId authorId parentId body hiddenByReportsAt')
      .lean<CommentBrief[]>()
      .exec();
  },

  /** Caller checks who may delete (comment author or post author). */
  softDelete(storyId: Types.ObjectId, id: Types.ObjectId): Promise<FriendStoryCommentDoc | null> {
    return FriendStoryComment.findOneAndUpdate({ _id: id, storyId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  /**
   * A root comment was deleted: its live replies go with it. Returns their ids (to drop notifications) and how many this
   * call deleted (to fix the count; another request may have deleted one of them in between).
   */
  async softDeleteReplies(storyId: Types.ObjectId, rootId: Types.ObjectId): Promise<{ ids: Types.ObjectId[]; removed: number }> {
    const rows = await FriendStoryComment.find({ storyId, parentId: rootId, ...alive }).select('_id').lean<{ _id: Types.ObjectId }[]>().exec();
    if (rows.length === 0) return { ids: [], removed: 0 };
    const ids = rows.map((r) => r._id);
    const res = await FriendStoryComment.updateMany({ _id: { $in: ids }, ...alive }, { $set: { deletedAt: new Date() } }).exec();
    return { ids, removed: res.modifiedCount };
  },

  async hideByReports(id: Types.ObjectId): Promise<boolean> {
    const res = await FriendStoryComment.updateOne({ _id: id, hiddenByReportsAt: null }, { $set: { hiddenByReportsAt: new Date() } }).exec();
    return res.modifiedCount > 0;
  },
};
