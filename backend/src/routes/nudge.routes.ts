import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { moodLimiter } from '../middleware/rateLimit.js';
import { DEFAULT_MOOD_DAYS, MAX_MOOD_DAYS, MAX_MOOD_NOTE, MOODS } from '../models/CoupleMood.js';
import { NUDGE_KINDS } from '../models/CoupleNudge.js';
import { moodService } from '../services/mood.service.js';
import { nudgeService } from '../services/nudge.service.js';
import { ok } from '../utils/response.js';

/**
 * "Nhớ bạn" một chạm + cảm xúc hôm nay (plan/COUPLE_V2_PLAN.md, CP5). Home reads both through GET /api/couple/pulse.
 * No ids in these routes: everything is the caller's couple (req.couple).
 */
export const nudgeRouter = Router();
nudgeRouter.use(requireAuth, requireCouple);

export const moodRouter = Router();
moodRouter.use(requireAuth, requireCouple);

const nudgeSchema = z.object({ kind: z.enum(NUDGE_KINDS) });
const moodSchema = z.object({
  mood: z.enum(MOODS),
  note: z.string().trim().max(MAX_MOOD_NOTE, `Ghi chú tối đa ${MAX_MOOD_NOTE} ký tự`).default(''),
});
const historyQuery = z.object({
  days: z.coerce
    .number()
    .int('Số ngày phải là số nguyên')
    .min(1, 'Số ngày từ 1 tới 90')
    .max(MAX_MOOD_DAYS, `Số ngày từ 1 tới ${MAX_MOOD_DAYS}`)
    .default(DEFAULT_MOOD_DAYS),
});

/**
 * POST /api/nudges { kind: miss|hug|kiss|thinking } → { id, kind, createdAt, sentToday, remainingToday, nextAt }.
 * 30 s between two nudges of the same person (429 NUDGE_TOO_SOON) and 50 per day (429 NUDGE_DAILY_LIMIT), both with
 * details.retryAfter in seconds. Pushes to the partner.
 */
nudgeRouter.post(
  '/',
  validate({ body: nudgeSchema }),
  asyncHandler(async (req, res) => ok(res, await nudgeService.send(req.couple!, req.userId!, req.body.kind), 201)),
);

/** PUT /api/moods/today { mood, note? (≤ 140) } → MoodView. One per member per day; saving again overwrites. */
moodRouter.put(
  '/today',
  moodLimiter,
  validate({ body: moodSchema }),
  asyncHandler(async (req, res) => ok(res, await moodService.setToday(req.couple!, req.userId!, req.body))),
);

/** GET /api/moods?days=30 (1–90) → { days, from, to, items } for both members, oldest day first. */
moodRouter.get(
  '/',
  validate({ query: historyQuery }),
  asyncHandler(async (req, res) => ok(res, await moodService.history(req.couple!, Number(req.query.days ?? DEFAULT_MOOD_DAYS)))),
);
