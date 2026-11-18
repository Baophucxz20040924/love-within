import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { DuoMoment, MOMENT_SCHEDULE_VERSION, type DuoMomentDoc, type MomentPost, type MomentSession } from '../models/DuoMoment.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
function onlyDuplicates(err: unknown): boolean {
  const writeErrors = (err as { writeErrors?: { code?: number }[] | { code?: number } } | null)?.writeErrors;
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : [];
  return list.length > 0 && list.every((e) => e.code === 11000);
}
export interface NewMomentDay {
  coupleId: Types.ObjectId;
  localDate: string;
  scheduleVersion: number;
  timezone: string;
  sessions: MomentSession[];
}

/** Evaluated by Mongo at the write, not with a timestamp captured before storage HEAD / a queued DB operation. */
function openSessionExpr(sessionId: string, extra: object[] = []) {
  return { $anyElementTrue: [{ $map: {
    input: { $ifNull: ['$sessions', []] }, as: 's',
    in: { $and: [
      { $eq: ['$$s.id', { $literal: sessionId }] },
      { $lte: ['$$s.promptAt', '$$NOW'] },
      { $gt: ['$$s.closesAt', '$$NOW'] },
      ...extra,
    ] },
  } }] };
}
export const momentRepository = {
  findDay(coupleId: Types.ObjectId, localDate: string): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOne({ coupleId, localDate }).exec();
  },
  async ensureDay(day: NewMomentDay): Promise<DuoMomentDoc> {
    const filter = { coupleId: day.coupleId, localDate: day.localDate };
    try {
      return await DuoMoment.findOneAndUpdate(filter, { $setOnInsert: day }, { upsert: true, new: true }).exec();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const doc = await DuoMoment.findOne(filter).exec();
      if (!doc) throw err;
      return doc;
    }
  },
  async existingDays(pairs: { coupleId: Types.ObjectId; localDate: string }[]): Promise<Set<string>> {
    if (!pairs.length) return new Set();
    const rows = await DuoMoment.find({ coupleId: { $in: pairs.map((p) => p.coupleId) }, localDate: { $in: [...new Set(pairs.map((p) => p.localDate))] } })
      .select('coupleId localDate').lean().exec();
    return new Set(rows.map((r) => `${r.coupleId.toString()}|${r.localDate}`));
  },
  async createDays(days: NewMomentDay[]): Promise<number> {
    if (!days.length) return 0;
    const ops = days.map((day) => ({ updateOne: {
      filter: { coupleId: day.coupleId, localDate: day.localDate }, update: { $setOnInsert: day }, upsert: true,
    } }));
    try {
      return (await DuoMoment.bulkWrite(ops, { ordered: false })).upsertedCount;
    } catch (err) {
      if (!onlyDuplicates(err)) throw err;
      return (err as { result?: { upsertedCount?: number } }).result?.upsertedCount ?? 0;
    }
  },
  async listDueToNotify(days: string[], now: Date, limit: number): Promise<{ id: Types.ObjectId; sessionId: string }[]> {
    const rows = await DuoMoment.find({
      localDate: { $in: days }, scheduleVersion: MOMENT_SCHEDULE_VERSION,
      sessions: { $elemMatch: { notifiedAt: null, promptAt: { $lte: now }, rewardEndsAt: { $gt: now }, closesAt: { $gt: now } } },
    }).select('_id sessions.id sessions.promptAt sessions.rewardEndsAt sessions.closesAt sessions.notifiedAt').limit(limit).lean().exec();
    return rows.flatMap((r) => (r.sessions ?? []).filter((s) => !s.notifiedAt && s.promptAt <= now && s.rewardEndsAt && s.rewardEndsAt > now && s.closesAt > now)
      .map((s) => ({ id: r._id, sessionId: s.id }))).slice(0, limit);
  },
  markNotified(id: Types.ObjectId, sessionId: string): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate({
      _id: id, scheduleVersion: MOMENT_SCHEDULE_VERSION,
      sessions: { $elemMatch: { id: sessionId, notifiedAt: null } },
      $expr: openSessionExpr(sessionId, [{ $eq: ['$$s.notifiedAt', null] }, { $gt: ['$$s.rewardEndsAt', '$$NOW'] }]),
    }, { $currentDate: { 'sessions.$.notifiedAt': true } }, { new: true }).exec();
  },
  /** The DB supplies both timing fields from the same instant used by the acceptance predicate. */
  addPost(coupleId: Types.ObjectId, localDate: string, sessionId: string, post: Omit<MomentPost, 'postedAt' | 'lateMin'>): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate({
      coupleId, localDate, scheduleVersion: MOMENT_SCHEDULE_VERSION,
      sessions: { $elemMatch: { id: sessionId, 'posts.userId': { $ne: post.userId }, 'posts.1': { $exists: false } } },
      $expr: openSessionExpr(sessionId, [
        { $not: [{ $in: [post.userId, '$$s.posts.userId'] }] },
        { $lt: [{ $size: '$$s.posts' }, 2] },
      ]),
    }, [{
      $set: {
        effectsPending: true,
        rewardSettlementPending: true,
        sessions: {
          $map: {
            input: '$sessions', as: 's',
            in: {
              $cond: [
                { $eq: ['$$s.id', { $literal: sessionId }] },
                {
                  $mergeObjects: ['$$s', {
                    posts: {
                      $concatArrays: ['$$s.posts', [{
                        $mergeObjects: [
                          // Pipeline values must remain literal, even captions/keys beginning with "$".
                          { $literal: { userId: post.userId, key: post.key, width: post.width, height: post.height, caption: post.caption } },
                          {
                            postedAt: '$$NOW',
                            effectsCompletedAt: null,
                            effectsBoth: { $gte: [{ $size: '$$s.posts' }, 1] },
                            lateMin: {
                              $cond: [
                                { $lt: ['$$NOW', '$$s.rewardEndsAt'] }, 0,
                                { $max: [1, { $ceil: { $divide: [{ $subtract: ['$$NOW', '$$s.rewardEndsAt'] }, 60_000] } }] },
                              ],
                            },
                          },
                        ],
                      }]],
                    },
                  }],
                },
                '$$s',
              ],
            },
          },
        },
      },
    }], { new: true }).exec();
  },
  async claimEffects(coupleId?: Types.ObjectId): Promise<DuoMomentDoc | null> {
    const token = randomUUID();
    return DuoMoment.findOneAndUpdate({
      effectsPending: true, ...(coupleId ? { coupleId } : {}),
      $expr: { $lte: [{ $ifNull: ['$effectsLeaseUntil', new Date(0)] }, '$$NOW'] },
    }, [{ $set: { effectsLeaseToken: { $literal: token }, effectsLeaseUntil: { $add: ['$$NOW', 60_000] } } }],
    // Untouched/null deadlines come first; failed work moves behind earlier-due work, not back to the oldest ID.
    { new: true, sort: { effectsLeaseUntil: 1, _id: 1 }, timestamps: false }).exec();
  },
  async completePostEffects(id: Types.ObjectId, token: string, sessionId: string, userId: Types.ObjectId): Promise<void> {
    await DuoMoment.updateOne({ _id: id, effectsLeaseToken: token }, {
      $currentDate: { 'sessions.$[s].posts.$[p].effectsCompletedAt': true },
    }, { arrayFilters: [{ 's.id': sessionId }, { 'p.userId': userId, 'p.effectsCompletedAt': null, 'p.effectsBoth': { $exists: true } }], timestamps: false }).exec();
  },
  async releaseEffects(id: Types.ObjectId, token: string, completed: boolean): Promise<void> {
    if (completed) {
      // Never clear a concurrent partner's newly committed work.
      await DuoMoment.updateOne({ _id: id, effectsLeaseToken: token,
        sessions: { $not: { $elemMatch: { posts: { $elemMatch: { effectsCompletedAt: null, effectsBoth: { $exists: true } } } } } },
      }, { $set: { effectsPending: false } }, { timestamps: false }).exec();
    }
    // Retry deadlines use the same DB clock as claims, independent of worker clock skew.
    await DuoMoment.updateOne({ _id: id, effectsLeaseToken: token }, [{
      $set: { effectsLeaseToken: null, effectsLeaseUntil: completed ? null : { $add: ['$$NOW', 60_000] } },
    }], { timestamps: false }).exec();
  },
  listRange(coupleId: Types.ObjectId, from: string, to: string): Promise<DuoMomentDoc[]> {
    return DuoMoment.find({ coupleId, localDate: { $gte: from, $lte: to } }).sort({ localDate: 1 }).limit(40).exec();
  },
  async bothDays(coupleId: Types.ObjectId, limit: number): Promise<string[]> {
    const rows = await DuoMoment.find({ coupleId, $or: [
      { sessions: { $elemMatch: { 'posts.1': { $exists: true } } } },
      { sessions: { $exists: false }, 'posts.1': { $exists: true } },
    ] }).select('localDate').sort({ localDate: -1 }).limit(limit).lean().exec();
    return rows.map((r) => r.localDate);
  },
  /** One Story link per session. Legacy days are read-only, including Story creation. */
  setStory(coupleId: Types.ObjectId, id: Types.ObjectId, sessionId: string, expected: Types.ObjectId | null, storyId: Types.ObjectId): Promise<DuoMomentDoc | null> {
    return DuoMoment.findOneAndUpdate({
      _id: id, coupleId, scheduleVersion: MOMENT_SCHEDULE_VERSION,
      sessions: { $elemMatch: { id: sessionId, storyId: expected, 'posts.1': { $exists: true } } },
    }, { $set: { 'sessions.$.storyId': storyId } }, { new: true }).exec();
  },
};
