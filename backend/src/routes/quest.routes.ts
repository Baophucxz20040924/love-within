import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { checkinLimiter } from '../middleware/rateLimit.js';
import { checkinService } from '../services/checkin.service.js';
import { questService } from '../services/quest.service.js';
import { ok } from '../utils/response.js';

export const questRouter = Router();

/** GET /api/checkin — today's check-in status for the caller. */
questRouter.get(
  '/checkin',
  requireAuth, requireCouple,
  asyncHandler(async (req, res) => {
    ok(res, await checkinService.status(req.couple!, req.userId!));
  }),
);

/** POST /api/checkin */
questRouter.post(
  '/checkin',
  requireAuth, requireCouple,
  checkinLimiter,
  asyncHandler(async (req, res) => {
    ok(res, await checkinService.checkin(req.couple!, req.userId!), 201);
  }),
);

/** GET /api/quests/today */
questRouter.get(
  '/quests/today',
  requireAuth, requireCouple,
  asyncHandler(async (req, res) => {
    ok(res, await questService.getToday(req.couple!));
  }),
);

const questKeyParam = z.object({ questKey: z.string().min(1).max(64) });

/** POST /api/quests/:questKey/claim */
questRouter.post(
  '/quests/:questKey/claim',
  requireAuth, requireCouple,
  validate({ params: questKeyParam }),
  asyncHandler(async (req, res) => {
    ok(res, await questService.claim(req.couple!, req.userId!, req.params.questKey));
  }),
);
