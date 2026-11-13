import { Router } from 'express';
import { expensiveReadLimiter, savingsWriteLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { listProposalsQuery, proposalController, proposalIdParam } from '../controllers/proposal.controller.js';

export const proposalRouter = Router();

proposalRouter.use(requireAuth, requireCouple);

proposalRouter.get('/', expensiveReadLimiter, validate({ query: listProposalsQuery }), asyncHandler(proposalController.list));
proposalRouter.post('/:id/approve', savingsWriteLimiter, validate({ params: proposalIdParam }), asyncHandler(proposalController.approve));
proposalRouter.post('/:id/reject', savingsWriteLimiter, validate({ params: proposalIdParam }), asyncHandler(proposalController.reject));
