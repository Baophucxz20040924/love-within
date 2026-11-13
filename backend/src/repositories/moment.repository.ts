import { Types } from 'mongoose';
import { DuoMoment, type DuoMomentDoc, type MomentPost } from '../models/DuoMoment.js';

/** Mongo duplicate-key error (a unique index refused an insert). */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Bulk write that failed only because of duplicate keys (another run or a lazy "today" inserted the same day). */
function onlyDuplicates(err: unknown): boolean {
  const writeErrors = (err as { writeErrors?: { code?: number }[] | { code?: number } } | null)?.writeErrors;
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : [];
  return list.length > 0 && list.every((e) => e.code === 11000);
}

export interface NewMomentDay {
  coupleId: Types.ObjectId;
  localDate: string;
  promptAt: Date;
  /** Set for a day created after the window has ended (no prompt push for it). */
  notifiedAt: Date | null;
}

/** Every query of the app is scoped by coupleId (Requirement 3.4); the job reads across couples by design. */
export const momentRepository = {
  findDay(coupleId: Types.ObjectId, localDate: string): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOne({ coupleId, localDate }).exec();
  },

  /**
   * The day's moment, created with these values unless it exists (upsert $setOnInsert on the unique (coupleId, localDate)
   * index). Two first opens at once, or the job next to a first open, still give one moment with one promptAt.
   */
  async ensureDay(day: NewMomentDay): Promise<DuoMomentDoc> {
    const filter = { coupleId: day.coupleId, localDate: day.localDate };
    try {
      return await DuoMoment.findOneAndUpdate(filter, { $setOnInsert: { ...day, posts: [], storyId: null } }, { upsert: true, new: true }).exec();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const doc = await DuoMoment.findOne(filter).exec();
      if (!doc) throw err;
      return doc;
    }
  },

  /** Which of these (couple, day) pairs already have a moment: `${coupleId}|${localDate}`. One indexed read per page of couples. */
  async existingDays(pairs: { coupleId: Types.ObjectId; localDate: string }[]): Promise<Set<string>> {
    if (pairs.length === 0) return new Set();
    const dates = [...new Set(pairs.map((p) => p.localDate))];
    const rows = await DuoMoment.find({ coupleId: { $in: pairs.map((p) => p.coupleId) }, localDate: { $in: dates } })
      .select('coupleId localDate')
      .lean()
      .exec();
    return new Set(rows.map((r) => `${r.coupleId.toString()}|${r.localDate}`));
  },

  /** Create the missing days of a page of couples (job). Returns how many this call inserted. */
  async createDays(days: NewMomentDay[]): Promise<number> {
    if (days.length === 0) return 0;
    const ops = days.map((d) => ({
      updateOne: {
        filter: { coupleId: d.coupleId, localDate: d.localDate },
        update: { $setOnInsert: { ...d, posts: [], storyId: null } },
        upsert: true,
      },
    }));
    try {
      const r = await DuoMoment.bulkWrite(ops, { ordered: false });
      return r.upsertedCount;
    } catch (err) {
      if (!onlyDuplicates(err)) throw err;
      return (err as { result?: { upsertedCount?: number } }).result?.upsertedCount ?? 0;
    }
  },

  /** Prompts whose time has come within the last `maxLateMs`, not announced yet (job). `days` bounds the index scan. */
  async listDueToNotify(days: string[], now: Date, maxLateMs: number, limit: number): Promise<Types.ObjectId[]> {
    const rows = await DuoMoment.find({
      localDate: { $in: days },
      notifiedAt: null,
      promptAt: { $lte: now, $gte: new Date(now.getTime() - maxLateMs) },
    })
      .select('_id')
      .sort({ promptAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((r) => r._id);
  },

  /** The job's guard: notifiedAt null → now, only while still due. null = another run took it (or it is no longer due). */
  markNotified(id: Types.ObjectId, now: Date, maxLateMs: number): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate(
      { _id: id, notifiedAt: null, promptAt: { $lte: now, $gte: new Date(now.getTime() - maxLateMs) } },
      { $set: { notifiedAt: now } },
      { new: true },
    ).exec();
  },

  /**
   * My photo of the day: one atomic $push, only after the prompt time, only when I have not posted and there are fewer
   * than two posts. Two posts of mine at once: one matches, the other gets null.
   */
  addPost(coupleId: Types.ObjectId, localDate: string, post: MomentPost, now: Date): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate(
      { coupleId, localDate, promptAt: { $lte: now }, 'posts.userId': { $ne: post.userId }, 'posts.1': { $exists: false } },
      { $push: { posts: post } },
      { new: true },
    ).exec();
  },

  /** Days of a month (from ≤ localDate ≤ to), oldest first. */
  listRange(coupleId: Types.ObjectId, from: string, to: string): Promise<DuoMomentDoc[]> {
    return DuoMoment.find({ coupleId, localDate: { $gte: from, $lte: to } }).sort({ localDate: 1 }).limit(40).exec();
  },

  /** Days on which both posted, newest first (for the streak). */
  async bothDays(coupleId: Types.ObjectId, limit: number): Promise<string[]> {
    const rows = await DuoMoment.find({ coupleId, 'posts.1': { $exists: true } })
      .select('localDate')
      .sort({ localDate: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((r) => r.localDate);
  },

  /** "Đăng lên Story": storyId goes from `expected` (null, or a story deleted since) to `storyId`; one request wins. */
  setStory(coupleId: Types.ObjectId, id: Types.ObjectId, expected: Types.ObjectId | null, storyId: Types.ObjectId): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate({ _id: id, coupleId, storyId: expected }, { $set: { storyId } }, { new: true }).exec();
  },
};
