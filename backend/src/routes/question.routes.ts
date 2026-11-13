import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { questionAnswerLimiter } from '../middleware/rateLimit.js';
import { MAX_ANSWER_BODY, MAX_ASK_TEXT, QUESTION_REACTIONS } from '../models/CoupleQuestion.js';
import { questionService } from '../services/question.service.js';
import { ok } from '../utils/response.js';

/** "Câu hỏi mỗi ngày" (plan/COUPLE_V2_PLAN.md, CP1). */
export const questionRouter = Router();
questionRouter.use(requireAuth, requireCouple);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });

const listQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Cursor không hợp lệ')
    .optional(),
  filter: z.enum(['all', 'unanswered']).default('all'),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

const answerSchema = z.object({
  body: z.string().trim().min(1, 'Hãy viết câu trả lời').max(MAX_ANSWER_BODY, `Câu trả lời tối đa ${MAX_ANSWER_BODY} ký tự`),
});
const reactionSchema = z.object({ type: z.enum(QUESTION_REACTIONS) });
const askSchema = z.object({
  text: z.string().trim().min(1, 'Hãy viết câu hỏi').max(MAX_ASK_TEXT, `Câu hỏi tối đa ${MAX_ASK_TEXT} ký tự`),
});

/** GET /api/questions/today — created on first open; partner.body only once I have answered. */
questionRouter.get(
  '/today',
  asyncHandler(async (req, res) => ok(res, await questionService.today(req.couple!, req.userId!))),
);

/** POST /api/questions/ask { text } — "Hỏi người ấy": one per member per day (409 ASK_ALREADY_SENT). */
questionRouter.post(
  '/ask',
  validate({ body: askSchema }),
  asyncHandler(async (req, res) => ok(res, await questionService.ask(req.couple!, req.userId!, req.body.text), 201)),
);

/** GET /api/questions?cursor=&filter=all|unanswered&limit= — history, newest day first, 20 days per page. */
questionRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const filter = req.query.filter === 'unanswered' ? 'unanswered' : 'all';
    ok(res, await questionService.list(req.couple!, req.userId!, { cursor, filter, limit: Number(req.query.limit) }));
  }),
);

/** GET /api/questions/:id — any day, same hiding rule. */
questionRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await questionService.get(req.couple!, req.userId!, req.params.id))),
);

/** PUT /api/questions/:id/answer { body } — create or edit; 409 QUESTION_LOCKED once both answered. */
questionRouter.put(
  '/:id/answer',
  questionAnswerLimiter,
  validate({ params: idParam, body: answerSchema }),
  asyncHandler(async (req, res) => ok(res, await questionService.answer(req.couple!, req.userId!, req.params.id, req.body.body))),
);

/** PUT /api/questions/:id/reaction { type } — on the partner's answer; 409 QUESTION_NOT_LOCKED before both answered. */
questionRouter.put(
  '/:id/reaction',
  validate({ params: idParam, body: reactionSchema }),
  asyncHandler(async (req, res) => ok(res, await questionService.react(req.couple!, req.userId!, req.params.id, req.body.type))),
);

/** DELETE /api/questions/:id/reaction — remove my reaction. */
questionRouter.delete(
  '/:id/reaction',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await questionService.react(req.couple!, req.userId!, req.params.id, null))),
);
