import type { Types } from 'mongoose';
import { FriendSuggestionDismissal } from '../models/FriendSuggestionDismissal.js';

/** Dismissed friend suggestions (BB7). Every query is scoped by the user who dismissed. */
export const friendSuggestionRepository = {
  /** Idempotent: dismissing again moves `until`. */
  async dismiss(userId: Types.ObjectId, dismissedId: Types.ObjectId, until: Date): Promise<void> {
    await FriendSuggestionDismissal.updateOne(
      { userId, dismissedId },
      { $set: { until }, $setOnInsert: { userId, dismissedId } },
      { upsert: true },
    ).exec();
  },

  /** People the user dismissed whose 90 days are not over yet (most recent 5 000). */
  async activeIds(userId: Types.ObjectId, now: Date): Promise<Set<string>> {
    const rows = await FriendSuggestionDismissal.find({ userId, until: { $gt: now } })
      .sort({ until: -1 })
      .limit(5000)
      .select('dismissedId')
      .lean()
      .exec();
    return new Set(rows.map((r) => r.dismissedId.toString()));
  },
};
