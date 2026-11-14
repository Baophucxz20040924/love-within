import { Types } from 'mongoose';
import { DAILY_QUESTIONS, QUESTION_CATEGORIES, type DailyQuestion } from '../config/dailyQuestions.js';
import type { CoupleDoc } from '../models/Couple.js';
import type { CoupleAnswerDoc, CoupleQuestionDoc, QuestionReaction, QuestionSource } from '../models/CoupleQuestion.js';
import { answerRepository, askRepository, questionRepository } from '../repositories/question.repository.js';
import { DAILY_QUESTION_QUEST_KEY, questService } from './quest.service.js';
import { notificationService } from './notification.service.js';
import { formatDayVi, getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Privacy (plan/ENGINEERING_WORKFLOW.md, CP1): the partner's answer body is only ever returned to a member who has answered
// the same day. Answers and "Hỏi người ấy" texts are never logged and never sent to the AI.

const BANK_BY_ID = new Map(DAILY_QUESTIONS.map((q) => [q.id, q]));
if (BANK_BY_ID.size !== DAILY_QUESTIONS.length) throw new Error('config/dailyQuestions.ts: duplicate question id');

export interface QuestionAnswerView {
  body: string;
  /** The partner's reaction to this answer. */
  reaction: QuestionReaction | null;
  /** Answered after the question's day ("trả lời bù"). */
  late: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionView {
  id: string;
  localDate: string;
  text: string;
  /** Bank category label ("Kỷ niệm"…); null for a member's own question. */
  category: string | null;
  source: QuestionSource;
  /** Member who wrote it (source "partner"). */
  askedBy: string | null;
  mine: QuestionAnswerView | null;
  /** `body` and `reaction` (mine, on their answer) only once I have answered too. */
  partner: { answered: boolean; late?: boolean; body?: string; reaction?: QuestionReaction | null };
  /** Both answered: no more edits; reactions open. */
  locked: boolean;
}

export interface MyAskView {
  text: string;
  createdAt: string;
}

export interface TodayQuestionView extends QuestionView {
  /** My "Hỏi người ấy" question sent today, waiting for a later day. Only its author sees it. */
  myAsk: MyAskView | null;
}

export type PulseQuestionState = 'none' | 'partner_answered' | 'mine_answered' | 'both';

export interface QuestionPage {
  items: QuestionView[];
  nextCursor: string | null;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const locked409 = () => new AppError(409, 'QUESTION_LOCKED', 'Hai bạn đã cùng trả lời câu này nên không sửa được nữa.');

// ── Per-couple order of the bank ──

/** 32-bit FNV-1a hash: turns the coupleId into a PRNG seed. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32: tiny deterministic PRNG returning numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The couple's own order of the bank: a Fisher–Yates shuffle seeded by the coupleId (same order every time). */
export function bankOrderFor(coupleId: string): DailyQuestion[] {
  const order = [...DAILY_QUESTIONS];
  const rand = mulberry32(hashSeed(coupleId));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * First question in the couple's order that was asked the fewest times. Before the bank runs out that is the first
 * question never asked; afterwards the order starts over. Questions appended to the bank have count 0, so they
 * come before any repeat.
 */
function pickBankQuestion(coupleId: Types.ObjectId, usage: Map<string, number>): DailyQuestion | null {
  const order = bankOrderFor(coupleId.toString());
  let min = Infinity;
  for (const q of order) min = Math.min(min, usage.get(q.id) ?? 0);
  return order.find((q) => (usage.get(q.id) ?? 0) === min) ?? null;
}

/**
 * The couple's question for `localDate`, created on first use. A waiting "Hỏi người ấy" question sent on an earlier day
 * wins over the bank (oldest first). The upsert is atomic, so concurrent first opens create one question; only the
 * request that inserted it marks the member's question as used.
 */
async function ensureDay(couple: CoupleDoc, localDate: string): Promise<CoupleQuestionDoc> {
  const existing = await questionRepository.findByDate(couple._id, localDate);
  if (existing) return existing;

  const ask = await askRepository.nextPending(couple._id, localDate);
  let content: { questionId: string | null; text: string; source: QuestionSource; askedBy: Types.ObjectId | null };
  if (ask) {
    content = { questionId: null, text: ask.text, source: 'partner', askedBy: ask.fromUserId };
  } else {
    const q = pickBankQuestion(couple._id, await questionRepository.bankUsage(couple._id));
    if (!q) throw Errors.internal('Kho câu hỏi đang trống');
    content = { questionId: q.id, text: q.text, source: 'bank', askedBy: null };
  }

  const inserted = await questionRepository.insertIfAbsent({ coupleId: couple._id, localDate, ...content });
  if (inserted) {
    if (ask) await askRepository.markUsed(couple._id, ask._id, localDate);
    logger.info('Daily question created', {
      coupleId: couple._id.toString(),
      localDate,
      source: content.source,
      questionId: content.questionId,
    });
  }
  const doc = await questionRepository.findByDate(couple._id, localDate);
  if (!doc) throw Errors.internal('Không tạo được câu hỏi hôm nay');
  return doc;
}

function today(couple: CoupleDoc): string {
  return getLocalDate(new Date(), couple.timezone);
}

async function requireQuestion(couple: CoupleDoc, id: string): Promise<CoupleQuestionDoc> {
  const q = await questionRepository.findById(couple._id, id);
  if (!q) throw Errors.notFound('Câu hỏi không tồn tại');
  return q;
}

function partnerOf(couple: CoupleDoc, userId: string): Types.ObjectId | null {
  return couple.memberIds.find((m) => m.toString() !== userId) ?? null;
}

function toView(couple: CoupleDoc, q: CoupleQuestionDoc, answers: CoupleAnswerDoc[], userId: string): QuestionView {
  const own = answers.filter((a) => a.questionDayId.equals(q._id));
  const mine = own.find((a) => a.userId.toString() === userId) ?? null;
  const partner = own.find((a) => a.userId.toString() !== userId) ?? null;
  const late = (a: CoupleAnswerDoc) => getLocalDate(a.createdAt, couple.timezone) > q.localDate;
  const bank = q.questionId ? BANK_BY_ID.get(q.questionId) : undefined;

  let partnerView: QuestionView['partner'] = { answered: false };
  if (partner) {
    // The partner's words are only shown once I have answered too (never before, whatever the client asks for).
    partnerView = mine
      ? { answered: true, late: late(partner), body: partner.body, reaction: partner.reaction ?? null }
      : { answered: true, late: late(partner) };
  }

  return {
    id: q._id.toString(),
    localDate: q.localDate,
    text: q.text,
    category: bank ? QUESTION_CATEGORIES[bank.category] : null,
    source: q.source,
    askedBy: q.askedBy ? q.askedBy.toString() : null,
    mine: mine
      ? {
          body: mine.body,
          reaction: mine.reaction ?? null,
          late: late(mine),
          createdAt: mine.createdAt.toISOString(),
          updatedAt: mine.updatedAt.toISOString(),
        }
      : null,
    partner: partnerView,
    locked: Boolean(mine && partner),
  };
}

async function viewOf(couple: CoupleDoc, q: CoupleQuestionDoc, userId: string): Promise<QuestionView> {
  return toView(couple, q, await answerRepository.listFor(couple._id, [q._id]), userId);
}

export const questionService = {
  async today(couple: CoupleDoc, userId: string): Promise<TodayQuestionView> {
    const localDate = today(couple);
    const q = await ensureDay(couple, localDate);
    const [view, ask] = await Promise.all([
      viewOf(couple, q, userId),
      askRepository.findMine(couple._id, new Types.ObjectId(userId), localDate),
    ]);
    return { ...view, myAsk: ask && !ask.usedOn ? { text: ask.text, createdAt: ask.createdAt.toISOString() } : null };
  },

  async get(couple: CoupleDoc, userId: string, id: string): Promise<QuestionView> {
    return viewOf(couple, await requireQuestion(couple, id), userId);
  },

  /** History, newest day first; `unanswered` = days I have not answered yet (late answers are allowed). */
  async list(
    couple: CoupleDoc,
    userId: string,
    opts: { cursor?: string; filter: 'all' | 'unanswered'; limit: number },
  ): Promise<QuestionPage> {
    const uid = new Types.ObjectId(userId);
    // Opening the history first thing in the day still lists today's question.
    if (!opts.cursor) await ensureDay(couple, today(couple));
    const exclude = opts.filter === 'unanswered' ? await answerRepository.answeredQuestionIds(couple._id, uid) : [];
    const docs = await questionRepository.list(couple._id, opts.cursor, exclude, opts.limit);
    const page = docs.slice(0, opts.limit);
    const answers = await answerRepository.listFor(couple._id, page.map((q) => q._id));
    return {
      items: page.map((q) => toView(couple, q, answers, userId)),
      nextCursor: docs.length > opts.limit ? page[page.length - 1].localDate : null,
    };
  },

  /**
   * Create or edit my answer. Editable until the partner answers; then both answers are locked (409 QUESTION_LOCKED).
   * Any earlier day can still be answered ("trả lời bù"); only today's answers count for the daily quest.
   */
  async answer(couple: CoupleDoc, userId: string, id: string, body: string): Promise<QuestionView> {
    const q = await requireQuestion(couple, id);
    const uid = new Types.ObjectId(userId);
    const text = body.trim();
    if (!text) throw Errors.badRequest('Hãy viết câu trả lời');

    let created = false;
    let mine = await answerRepository.updateBodyIfUnlocked(couple._id, q._id, uid, text);
    if (!mine) {
      if (await answerRepository.findOne(couple._id, q._id, uid)) throw locked409();
      try {
        mine = await answerRepository.create({ coupleId: couple._id, questionDayId: q._id, userId: uid, body: text });
        created = true;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // Double tap: the other request created it a moment ago. Treat this one as an edit.
        mine = await answerRepository.updateBodyIfUnlocked(couple._id, q._id, uid, text);
        if (!mine) throw locked409();
      }
    }

    if (created) {
      const count = await answerRepository.countFor(couple._id, q._id);
      const lockedNow = count >= couple.memberIds.length;
      // Lock both answers before reading the partner's for the response, so no edit can land after it was shown.
      if (lockedNow) await answerRepository.lockAll(couple._id, q._id, new Date());
      const localDate = today(couple);
      // Push to the partner (never the answer itself): first answer → their turn; second answer → both can read now.
      const day = q.localDate === localDate ? 'câu hỏi hôm nay' : `câu hỏi ngày ${formatDayVi(q.localDate)}`;
      await notificationService.toPartner(couple, uid, {
        type: lockedNow ? 'question_both' : 'question_answered',
        entityId: q._id,
        push: {
          body: (name) => (lockedNow ? `${name} cũng đã trả lời ${day}. Xem câu trả lời của hai bạn` : `${name} đã trả lời ${day}. Đến lượt bạn!`),
          url: `/questions/${q._id.toString()}`,
          tag: `question:${q._id.toString()}`,
        },
      });
      if (q.localDate === localDate) await questService.refresh(couple, DAILY_QUESTION_QUEST_KEY, localDate);
      logger.info('Daily question answered', {
        coupleId: couple._id.toString(),
        userId,
        questionDayId: q._id.toString(),
        late: q.localDate < localDate,
        locked: lockedNow,
      });
    }
    return viewOf(couple, q, userId);
  },

  /** React to the partner's answer (never my own), only once both answered. null = remove. */
  async react(couple: CoupleDoc, userId: string, id: string, reaction: QuestionReaction | null): Promise<QuestionView> {
    const q = await requireQuestion(couple, id);
    const partner = partnerOf(couple, userId);
    const updated = partner ? await answerRepository.setReaction(couple._id, q._id, partner, reaction) : null;
    if (!updated) {
      throw new AppError(409, 'QUESTION_NOT_LOCKED', 'Khi cả hai cùng trả lời xong, bạn mới thả cảm xúc được.');
    }
    return viewOf(couple, q, userId);
  },

  /** "Hỏi người ấy": one own question per member per day; it becomes the question of a later day. */
  async ask(couple: CoupleDoc, userId: string, text: string): Promise<MyAskView> {
    const value = text.trim();
    if (!value) throw Errors.badRequest('Hãy viết câu hỏi');
    try {
      const ask = await askRepository.create({
        coupleId: couple._id,
        fromUserId: new Types.ObjectId(userId),
        text: value,
        localDate: today(couple),
      });
      logger.info('Daily question ask queued', { coupleId: couple._id.toString(), userId });
      return { text: ask.text, createdAt: ask.createdAt.toISOString() };
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new AppError(409, 'ASK_ALREADY_SENT', 'Hôm nay bạn đã gửi một câu hỏi rồi. Mai gửi tiếp nhé!');
      }
      throw err;
    }
  },

  /** Home card (GET /api/couple/pulse): today's question id and who has answered, from the caller's side. */
  async pulse(couple: CoupleDoc, userId: string): Promise<{ id: string; state: PulseQuestionState }> {
    const q = await ensureDay(couple, today(couple));
    const answers = await answerRepository.listFor(couple._id, [q._id]);
    const mine = answers.some((a) => a.userId.toString() === userId);
    const partner = answers.some((a) => a.userId.toString() !== userId);
    const state: PulseQuestionState = mine && partner ? 'both' : mine ? 'mine_answered' : partner ? 'partner_answered' : 'none';
    return { id: q._id.toString(), state };
  },
};
