import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { walletService } from '../services/wallet.service.js';
import { ok } from '../utils/response.js';
import type { LedgerType } from '../models/LedgerEntry.js';

export const walletRouter = Router();

/** GET /api/wallet */
walletRouter.get(
  '/wallet',
  requireAuth, requireCouple,
  asyncHandler(async (req, res) => {
    ok(res, await walletService.getView(req.coupleId!, req.userId!));
  }),
);

const ledgerQuery = z.object({ type: z.enum(['coin', 'exp']).optional() });
const ledgerPageQuery = ledgerQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(1024).optional(),
});

/** Additive history contract; the legacy array below stays unchanged. */
walletRouter.get(
  '/ledger/page',
  requireAuth, requireCouple,
  validate({ query: ledgerPageQuery }),
  asyncHandler(async (req, res) => {
    ok(res, await walletService.listLedgerPage(req.coupleId!, req.userId!,
      req.query as unknown as z.infer<typeof ledgerPageQuery>));
  }),
);

/** GET /api/ledger?type=coin|exp */
walletRouter.get(
  '/ledger',
  requireAuth, requireCouple,
  validate({ query: ledgerQuery }),
  asyncHandler(async (req, res) => {
    ok(res, await walletService.listLedger(req.coupleId!, req.userId!, req.query.type as LedgerType | undefined));
  }),
);
