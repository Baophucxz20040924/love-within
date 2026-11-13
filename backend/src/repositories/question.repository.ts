import { Types } from 'mongoose';
import {
  CoupleAnswer,
  CoupleQuestion,
  CoupleQuestionAsk,
  type CoupleAnswerDoc,
  type CoupleQuestionAskDoc,
  type CoupleQuestionDoc,
  type QuestionReaction,
  type QuestionSource,
} from '../models/CoupleQuestion.js';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Every query is scoped by coupleId (Requirement 3.4). */
export const questionRepository = {
  findByDate(coupleId: Types.ObjectId, localDate: string): Promise<CoupleQuestionDoc | null> {
    return CoupleQuestion.findOne({ coupleId, localDate }).exec();
  },

  findById(coupleId: Types.ObjectId, id: string): Promise<CoupleQuestionDoc | null> {
    return CoupleQuestion.findOne({ _id: id, coupleId }).exec();
  },

  /**
   * Create the day's question unless it already exists (atomic upsert on the unique (coupleId, localDate) index).
   * Returns true only for the call that inserted it, so two members opening the app at once still get one question.
   */
  async insertIfAbsent(input: {
    coupleId: Types.ObjectId;
    localDate: string;
    questionId: string | null;
    text: string;
    source: QuestionSource;
    askedBy: Types.ObjectId | null;
  }): Promise<boolean> {
    try {
      const r = await CoupleQuestion.updateOne(
        { coupleId: input.coupleId, localDate: input.localDate },
        { $setOnInsert: input },
        { upsert: true },
      ).exec();
      return r.upsertedCount === 1;
    } catch (err) {
      // Two concurrent upserts: the loser may get a duplicate-key error instead of matching the winner's row.
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  },

  /** How many times each bank question was asked to this couple. */
  async bankUsage(coupleId: Types.ObjectId): Promise<Map<string, number>> {
    const rows = await CoupleQuestion.aggregate<{ _id: string; n: number }>([
      { $match: { coupleId, source: 'bank' } },
      { $group: { _id: '$questionId', n: { $sum: 1 } } },
    ]).exec();
    return new Map(rows.map((r) => [r._id, r.n]));
  },

  /** History, newest day first. `before` is the cursor (a localDate). Fetches limit + 1 to detect another page. */
  list(coupleId: Types.ObjectId, before: string | undefined, excludeIds: Types.ObjectId[], limit: number): Promise<CoupleQuestionDoc[]> {
    const filter: Record<string, unknown> = { coupleId };
    if (before) filter.localDate = { $lt: before };
    if (excludeIds.length) filter._id = { $nin: excludeIds };
    return CoupleQuestion.find(filter).sort({ localDate: -1 }).limit(limit + 1).exec();
  },
};

export const answerRepository = {
  listFor(coupleId: Types.ObjectId, questionDayIds: Types.ObjectId[]): Promise<CoupleAnswerDoc[]> {
    if (questionDayIds.length === 0) return Promise.resolve([]);
    return CoupleAnswer.find({ coupleId, questionDayId: { $in: questionDayIds } }).exec();
  },

  findOne(coupleId: Types.ObjectId, questionDayId: Types.ObjectId, userId: Types.ObjectId): Promise<CoupleAnswerDoc | null> {
    return CoupleAnswer.findOne({ coupleId, questionDayId, userId }).exec();
  },

  /** Throws a duplicate-key error (11000) when this member already answered. */
  create(input: { coupleId: Types.ObjectId; questionDayId: Types.ObjectId; userId: Types.ObjectId; body: string }): Promise<CoupleAnswerDoc> {
    return CoupleAnswer.create(input);
  },

  /** Edit my answer only while it is not locked. Null = no answer yet, or locked. */
  updateBodyIfUnlocked(coupleId: Types.ObjectId, questionDayId: Types.ObjectId, userId: Types.ObjectId, body: string): Promise<CoupleAnswerDoc | null> {
    return CoupleAnswer.findOneAndUpdate({ coupleId, questionDayId, userId, lockedAt: null }, { $set: { body } }, { new: true }).exec();
  },

  countFor(coupleId: Types.ObjectId, questionDayId: Types.ObjectId): Promise<number> {
    return CoupleAnswer.countDocuments({ coupleId, questionDayId }).exec();
  },

  /** Both answered: no more edits on this day. */
  async lockAll(coupleId: Types.ObjectId, questionDayId: Types.ObjectId, at: Date): Promise<void> {
    await CoupleAnswer.updateMany({ coupleId, questionDayId, lockedAt: null }, { $set: { lockedAt: at } }).exec();
  },

  /** Set or clear the reaction on `targetUserId`'s answer; only once the day is locked. Null = not locked / no answer. */
  setReaction(
    coupleId: Types.ObjectId,
    questionDayId: Types.ObjectId,
    targetUserId: Types.ObjectId,
    reaction: QuestionReaction | null,
  ): Promise<CoupleAnswerDoc | null> {
    return CoupleAnswer.findOneAndUpdate(
      { coupleId, questionDayId, userId: targetUserId, lockedAt: { $ne: null } },
      { $set: { reaction } },
      { new: true, timestamps: false },
    ).exec();
  },

  /** Ids of the days this member answered (for the "Chưa trả lời" filter). */
  async answeredQuestionIds(coupleId: Types.ObjectId, userId: Types.ObjectId): Promise<Types.ObjectId[]> {
    return CoupleAnswer.distinct('questionDayId', { coupleId, userId }).exec() as Promise<Types.ObjectId[]>;
  },
};

export const askRepository = {
  /** Throws a duplicate-key error (11000) when this member already sent one today. */
  create(input: { coupleId: Types.ObjectId; fromUserId: Types.ObjectId; text: string; localDate: string }): Promise<CoupleQuestionAskDoc> {
    return CoupleQuestionAsk.create({ ...input, usedOn: null });
  },

  /** Oldest waiting question sent before `localDate` (a question sent today is for a later day). */
  nextPending(coupleId: Types.ObjectId, localDate: string): Promise<CoupleQuestionAskDoc | null> {
    return CoupleQuestionAsk.findOne({ coupleId, usedOn: null, localDate: { $lt: localDate } })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
  },

  async markUsed(coupleId: Types.ObjectId, id: Types.ObjectId, usedOn: string): Promise<void> {
    await CoupleQuestionAsk.updateOne({ _id: id, coupleId, usedOn: null }, { $set: { usedOn } }).exec();
  },

  findMine(coupleId: Types.ObjectId, fromUserId: Types.ObjectId, localDate: string): Promise<CoupleQuestionAskDoc | null> {
    return CoupleQuestionAsk.findOne({ coupleId, fromUserId, localDate }).exec();
  },
};
