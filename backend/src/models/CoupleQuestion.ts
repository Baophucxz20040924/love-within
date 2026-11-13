import { Schema, model, type Document, type Types } from 'mongoose';

/** "Câu hỏi mỗi ngày" (plan/COUPLE_V2_PLAN.md, CP1). */

export const MAX_ANSWER_BODY = 1000;
export const MAX_ASK_TEXT = 200;

/** Reaction to the partner's answer. Keys only; the frontend owns the emoji (❤️ 😂 🥹 😮 👍). */
export const QUESTION_REACTIONS = ['heart', 'laugh', 'touched', 'wow', 'like'] as const;
export type QuestionReaction = (typeof QUESTION_REACTIONS)[number];

export type QuestionSource = 'bank' | 'partner';

/** One question per couple per day, created lazily by the first member who opens it. */
export interface CoupleQuestionDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  /** "YYYY-MM-DD" in the couple timezone. */
  localDate: string;
  /** Bank id ("q042"); null for a question written by a member ("Hỏi người ấy"). */
  questionId: string | null;
  /** Copy of the text at the time it was asked (the bank may be reworded later). */
  text: string;
  source: QuestionSource;
  /** Member who wrote it (source "partner"), else null. */
  askedBy: Types.ObjectId | null;
  createdAt: Date;
}

const questionSchema = new Schema<CoupleQuestionDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    localDate: { type: String, required: true },
    questionId: { type: String, default: null },
    text: { type: String, required: true },
    source: { type: String, enum: ['bank', 'partner'], required: true },
    askedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One question per couple per day (the lazy upsert relies on it); also serves the history (newest first).
questionSchema.index({ coupleId: 1, localDate: 1 }, { unique: true });

export const CoupleQuestion = model<CoupleQuestionDoc>('CoupleQuestion', questionSchema);

export interface CoupleAnswerDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  questionDayId: Types.ObjectId;
  userId: Types.ObjectId;
  body: string;
  /** The OTHER member's reaction to this answer. */
  reaction: QuestionReaction | null;
  /**
   * Set on both answers when the second one arrives. Edits require it to be null, so an edit can never
   * land after the partner has read the answer (the API's `locked` is still "both answered").
   */
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const answerSchema = new Schema<CoupleAnswerDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    questionDayId: { type: Schema.Types.ObjectId, ref: 'CoupleQuestion', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: MAX_ANSWER_BODY },
    reaction: { type: String, enum: [...QUESTION_REACTIONS, null], default: null },
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

answerSchema.index({ questionDayId: 1, userId: 1 }, { unique: true });
// "Chưa trả lời" filter: the ids of the days I answered.
answerSchema.index({ coupleId: 1, userId: 1, questionDayId: 1 });

export const CoupleAnswer = model<CoupleAnswerDoc>('CoupleAnswer', answerSchema);

/** "Hỏi người ấy": a member's own question, waiting to become a later day's question. */
export interface CoupleQuestionAskDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  fromUserId: Types.ObjectId;
  text: string;
  /** Day it was sent (couple timezone): one per member per day, and only used on a later day. */
  localDate: string;
  /** Day it became the question, or null while waiting. */
  usedOn: string | null;
  createdAt: Date;
}

const askSchema = new Schema<CoupleQuestionAskDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: MAX_ASK_TEXT },
    localDate: { type: String, required: true },
    usedOn: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Waiting questions, oldest first.
askSchema.index({ coupleId: 1, usedOn: 1, createdAt: 1 });
// At most one per member per day, even with a double tap.
askSchema.index({ coupleId: 1, fromUserId: 1, localDate: 1 }, { unique: true });

export const CoupleQuestionAsk = model<CoupleQuestionAskDoc>('CoupleQuestionAsk', askSchema);
