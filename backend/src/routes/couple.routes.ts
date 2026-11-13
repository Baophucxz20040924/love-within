import { Router } from 'express';
import { expensiveReadLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { buildCoupleView } from '../services/couple.service.js';
import { proposalService } from '../services/proposal.service.js';
import { pulseService } from '../services/pulse.service.js';
import { anniversaryPayloadSchema } from '../services/proposalHandlers/anniversary.handler.js';
import { ok } from '../utils/response.js';

export const coupleRouter = Router();

coupleRouter.use(requireAuth, requireCouple);

/** GET /api/couple — couple info incl. days-in-love computed in couple timezone. */
coupleRouter.get(
  '/', expensiveReadLimiter,
  asyncHandler(async (req, res) => {
    ok(res, await buildCoupleView(req.couple!));
  }),
);

/** GET /api/couple/pulse — combined Home data (polled every 30 s while the tab is visible). See pulse.service.ts. */
coupleRouter.get(
  '/pulse', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await pulseService.build(req.couple!, req.userId!))),
);

/** POST /api/couple/anniversary/propose — dual-approval change of anniversaryDate. */
coupleRouter.post(
  '/anniversary/propose',
  validate({ body: anniversaryPayloadSchema }),
  asyncHandler(async (req, res) => {
    const view = await proposalService.create(req.couple!, req.userId!, 'anniversary_date', req.body);
    ok(res, view, 201);
  }),
);

// No unpair endpoint: members cannot unpair themselves (owner decision 05/11/2026).
// Unpairing will be handled by a future admin tool via pairingService.unpair.
