import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { momentUploadLimiter, storyCreateLimiter } from '../middleware/rateLimit.js';
import { MAX_MOMENT_CAPTION } from '../models/DuoMoment.js';
import { momentService, requireMomentTarget } from '../services/moment.service.js';
import { STORY_IMAGE_TYPES } from '../services/story.service.js';
import { isRealDate } from '../utils/date.js';
import { ok } from '../utils/response.js';

/** "Khoảnh khắc đôi" (plan/ENGINEERING_WORKFLOW.md, CP6). What is hidden before the prompt or before my own post: moment.service.ts. */
export const momentRouter = Router();
momentRouter.use(requireAuth, requireCouple);

const targetFields = {
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate),
  sessionId: z.string().uuid(),
};
// Return a helpful reload error for old clients before normal shape validation.
momentRouter.use((req, _res, next) => {
  if (req.method === 'POST') {
    try { requireMomentTarget({ localDate: req.params.localDate ?? req.body?.localDate ?? (req.path.endsWith('/story') ? req.path.split('/')[1] : undefined), sessionId: req.body?.sessionId }); }
    catch (err) { next(err); return; }
  }
  next();
});

const uploadSchema = z.object({
  ...targetFields,
  mimeType: z.enum(Object.keys(STORY_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});

const postSchema = z.object({
  ...targetFields,
  key: z.string().min(1).max(300),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  caption: z.string().trim().max(MAX_MOMENT_CAPTION, `Tối đa ${MAX_MOMENT_CAPTION} ký tự`).default(''),
});

const monthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng phải có dạng YYYY-MM'),
});

const dayParam = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD').refine(isRealDate, 'Ngày không có thật'),
});

/** GET /api/moments/today → today's view (created on first use); no prompt time before it, no partner photo before mine. */
momentRouter.get(
  '/today',
  asyncHandler(async (req, res) => ok(res, await momentService.today(req.couple!, req.userId!))),
);

/** POST /api/moments/upload-url → presigned PUT (key under couples/<coupleId>/moments/); 409 before the prompt or after my post. */
momentRouter.post(
  '/upload-url',
  momentUploadLimiter,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await momentService.createUploadUrl(req.couple!, req.userId!, req.body, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

/** POST /api/moments/today { key, width, height, caption } → today's view; 409 MOMENT_NOT_YET / MOMENT_ALREADY_POSTED. */
momentRouter.post(
  '/today',
  validate({ body: postSchema }),
  asyncHandler(async (req, res) => ok(res, await momentService.post(req.couple!, req.userId!, req.body), 201)),
);

/** GET /api/moments?month=YYYY-MM → { month, today, minMonth, days, streak }. */
momentRouter.get(
  '/',
  validate({ query: monthQuery }),
  asyncHandler(async (req, res) => ok(res, await momentService.month(req.couple!, req.userId!, req.query.month as string))),
);

/** POST /api/moments/:localDate/story → { moment, story }; both must have posted; once (409 MOMENT_STORY_EXISTS). Counts as a story post. */
momentRouter.post(
  '/:localDate/story',
  storyCreateLimiter,
  validate({ params: dayParam, body: z.object({ sessionId: targetFields.sessionId }) }),
  asyncHandler(async (req, res) => ok(res, await momentService.toStory(req.couple!, req.userId!, { localDate: req.params.localDate, sessionId: req.body.sessionId }), 201)),
);
