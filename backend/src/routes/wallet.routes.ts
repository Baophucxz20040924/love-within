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
walletRouter.use(requireAuth, requireCouple);

/** GET /api/wallet */
walletRouter.get(
  '/wallet',
  asyncHandler(async (req, res) => {
    ok(res, await walletService.getView(req.coupleId!, req.userId!));
  }),
);

const ledgerQuery = z.object({ type: z.enum(['coin', 'exp']).optional() });

/** GET /api/ledger?type=coin|exp */
walletRouter.get(
  '/ledger',
  validate({ query: ledgerQuery }),
  asyncHandler(async (req, res) => {
    ok(res, await walletService.listLedger(req.coupleId!, req.userId!, req.query.type as LedgerType | undefined));
  }),
);
