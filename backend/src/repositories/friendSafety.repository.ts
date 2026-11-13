import { Types } from 'mongoose';
import {
  FriendBlock,
  FriendHiddenStory,
  FriendReport,
  type FriendBlockDoc,
  type FriendReportDoc,
  type ReportReason,
  type ReportTarget,
} from '../models/FriendSafety.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const either = (a: Types.ObjectId, b: Types.ObjectId) => ({
  $or: [
    { blockerId: a, blockedId: b },
    { blockerId: b, blockedId: a },
  ],
});

export const friendBlockRepository = {
  /** Idempotent: blocking twice keeps one row. */
  async block(blockerId: Types.ObjectId, blockedId: Types.ObjectId): Promise<void> {
    try {
      await FriendBlock.create({ blockerId, blockedId });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  },

  async isBlockedBy(blockerId: Types.ObjectId, blockedId: string | Types.ObjectId): Promise<boolean> {
    return (await FriendBlock.exists({ blockerId, blockedId }).exec()) !== null;
  },

  async unblock(blockerId: Types.ObjectId, blockedId: string | Types.ObjectId): Promise<boolean> {
    const res = await FriendBlock.deleteOne({ blockerId, blockedId }).exec();
    return res.deletedCount > 0;
  },

  listByBlocker(blockerId: Types.ObjectId): Promise<FriendBlockDoc[]> {
    return FriendBlock.find({ blockerId }).sort({ createdAt: -1 }).limit(500).exec();
  },

  /** Ids of everyone the user blocked or was blocked by: both directions hide people from each other. */
  async blockedIdsFor(userId: Types.ObjectId): Promise<Set<string>> {
    const rows = await FriendBlock.find({ $or: [{ blockerId: userId }, { blockedId: userId }] })
      .select('blockerId blockedId')
      .lean()
      .exec();
    return new Set(rows.map((r) => (r.blockerId.equals(userId) ? r.blockedId : r.blockerId).toString()));
  },

  async isBlockedBetween(a: Types.ObjectId, b: Types.ObjectId): Promise<boolean> {
    return (await FriendBlock.exists(either(a, b)).exec()) !== null;
  },
};

export const friendReportRepository = {
  /** Throws a duplicate-key error (11000) when the reporter already has an open report on this target. */
  create(input: {
    reporterId: Types.ObjectId;
    targetType: ReportTarget;
    targetId: Types.ObjectId;
    targetOwnerId: Types.ObjectId;
    reason: ReportReason;
    note: string;
  }): Promise<FriendReportDoc> {
    return FriendReport.create(input);
  },

  /** Different people with an open report on the target (one open report per person). */
  countOpen(targetType: ReportTarget, targetId: Types.ObjectId): Promise<number> {
    return FriendReport.countDocuments({ targetType, targetId, status: 'open' }).exec();
  },
};

export const friendHiddenStoryRepository = {
  async hide(userId: Types.ObjectId, storyId: Types.ObjectId): Promise<void> {
    await FriendHiddenStory.updateOne({ userId, storyId }, { $setOnInsert: { userId, storyId } }, { upsert: true }).exec();
  },

  async unhide(userId: Types.ObjectId, storyId: string): Promise<void> {
    await FriendHiddenStory.deleteOne({ userId, storyId }).exec();
  },

  /** Most recent 1 000 hidden posts (older ones are far down the feed anyway). */
  async hiddenIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const rows = await FriendHiddenStory.find({ userId }).sort({ createdAt: -1 }).limit(1000).select('storyId').lean().exec();
    return rows.map((r) => r.storyId);
  },
};
