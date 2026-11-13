import type { Types } from 'mongoose';
import { CoupleMood, type CoupleMoodDoc, type Mood } from '../models/CoupleMood.js';
import { CoupleNudge, type CoupleNudgeDoc, type NudgeKind } from '../models/CoupleNudge.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** One member's nudges to the other member of the couple. */
interface Pair {
  coupleId: Types.ObjectId;
  fromUserId: Types.ObjectId;
  toUserId: Types.ObjectId;
}

/** Every query is scoped by coupleId (Requirement 3.4) and goes through the { coupleId, toUserId, createdAt } index. */
export const nudgeRepository = {
  create(input: Pair & { kind: NudgeKind }): Promise<CoupleNudgeDoc> {
    return CoupleNudge.create(input);
  },

  /** The member's latest nudge to the partner (cooldown). */
  lastSent(p: Pair): Promise<CoupleNudgeDoc | null> {
    return CoupleNudge.findOne(p).sort({ createdAt: -1, _id: -1 }).exec();
  },

  /** Nudges the member sent to the partner at or after `since`. */
  countSentSince(p: Pair, since: Date): Promise<number> {
    return CoupleNudge.countDocuments({ ...p, createdAt: { $gte: since } }).exec();
  },

  /**
   * Nudges of the same member that come before `doc` (by createdAt, then _id) and are newer than `after`
   * (`inclusive`: at or after). Used right after an insert to find out whether a concurrent tap got there first.
   */
  countBefore(p: Pair, doc: CoupleNudgeDoc, after: Date, inclusive: boolean): Promise<number> {
    return CoupleNudge.countDocuments({
      ...p,
      createdAt: inclusive ? { $gte: after } : { $gt: after },
      $or: [{ createdAt: { $lt: doc.createdAt } }, { createdAt: doc.createdAt, _id: { $lt: doc._id } }],
    }).exec();
  },

  async deleteById(coupleId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
    await CoupleNudge.deleteOne({ _id: id, coupleId }).exec();
  },

  /** Nudges received by `toUserId` at or after `since` (Home pulse). */
  countReceivedSince(coupleId: Types.ObjectId, toUserId: Types.ObjectId, since: Date): Promise<number> {
    return CoupleNudge.countDocuments({ coupleId, toUserId, createdAt: { $gte: since } }).exec();
  },

  lastReceivedSince(coupleId: Types.ObjectId, toUserId: Types.ObjectId, since: Date): Promise<CoupleNudgeDoc | null> {
    return CoupleNudge.findOne({ coupleId, toUserId, createdAt: { $gte: since } })
      .sort({ createdAt: -1, _id: -1 })
      .exec();
  },
};

/** Every query is scoped by coupleId. */
export const moodRepository = {
  /** Set the member's mood of `localDate` (last write wins). Two saves at once: the loser of the upsert retries as an update. */
  async upsertDay(input: { coupleId: Types.ObjectId; userId: Types.ObjectId; localDate: string; mood: Mood; note: string }): Promise<CoupleMoodDoc> {
    const { coupleId, userId, localDate, mood, note } = input;
    const run = () =>
      CoupleMood.findOneAndUpdate({ coupleId, userId, localDate }, { $set: { mood, note } }, { upsert: true, new: true, setDefaultsOnInsert: true }).exec();
    try {
      return await run();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return run();
    }
  },

  /** The members' moods of one day. */
  listDay(coupleId: Types.ObjectId, userIds: Types.ObjectId[], localDate: string): Promise<CoupleMoodDoc[]> {
    return CoupleMood.find({ coupleId, userId: { $in: userIds }, localDate }).exec();
  },

  /** The members' moods from `from` to `to` (inclusive, "YYYY-MM-DD"), oldest day first. */
  listRange(coupleId: Types.ObjectId, userIds: Types.ObjectId[], from: string, to: string): Promise<CoupleMoodDoc[]> {
    return CoupleMood.find({ coupleId, userId: { $in: userIds }, localDate: { $gte: from, $lte: to } })
      .sort({ localDate: 1, userId: 1 })
      .limit(userIds.length * 100)
      .exec();
  },
};
