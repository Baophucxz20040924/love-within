import { Router } from 'express';
import { expensiveReadLimiter, savingsWriteLimiter } from '../middleware/rateLimit.js';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { savingsService } from '../services/savings.service.js';
import { proposalService } from '../services/proposal.service.js';
import { savingsCreateSchema, savingsUpdateSchema, savingsEntrySchema, savingsListSchema, savingsObjectId, savingsDay } from '../services/savings.validation.js';
import { ok } from '../utils/response.js';

export const savingsRouter = Router();
savingsRouter.use(requireAuth, requireCouple);
const id = z.object({ id: savingsObjectId });
const cursor = z.string().refine((v) => {
  const parts = v.split('_');
  return parts.length === 2 && savingsDay.safeParse(parts[0]).success && savingsObjectId.safeParse(parts[1]).success;
}, 'Con trỏ không hợp lệ');
savingsRouter.get('/', expensiveReadLimiter, validate({ query: savingsListSchema }),
  asyncHandler(async (req, res) => ok(res, await savingsService.list(req.couple!, savingsListSchema.parse(req.query)))));
savingsRouter.get('/suggestion', expensiveReadLimiter, asyncHandler(async (req, res) => ok(res, await savingsService.suggestion(req.userId!))));
savingsRouter.put('/pinned', savingsWriteLimiter, validate({ body: z.object({ goalId: savingsObjectId.nullable() }) }),
  asyncHandler(async (req, res) => ok(res, await savingsService.pin(req.couple!, req.userId!, req.body.goalId))));
savingsRouter.post('/propose', savingsWriteLimiter, validate({ body: savingsCreateSchema }),
  asyncHandler(async (req, res) => ok(res, await proposalService.create(req.couple!, req.userId!, 'savings_goal', req.body), 201)));
savingsRouter.get('/:id', expensiveReadLimiter, validate({ params: id, query: z.object({ cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) }),
  asyncHandler(async (req, res) => ok(res, await savingsService.detail(req.couple!, req.userId!, req.params.id, req.query.cursor as string | undefined, Number(req.query.limit)))));
savingsRouter.post('/:id/propose-update', savingsWriteLimiter, validate({ params: id, body: savingsUpdateSchema }),
  asyncHandler(async (req, res) => ok(res, await proposalService.create(req.couple!, req.userId!, 'savings_goal_update', { ...req.body, goalId: req.params.id }), 201)));
savingsRouter.post('/:id/entries', savingsWriteLimiter, validate({ params: id, body: savingsEntrySchema }),
  asyncHandler(async (req, res) => ok(res, await savingsService.add(req.couple!, req.userId!, req.params.id, req.body), 201)));
savingsRouter.delete('/:id/entries/:entryId', savingsWriteLimiter, validate({ params: z.object({ id: savingsObjectId, entryId: savingsObjectId }) }),
  asyncHandler(async (req, res) => ok(res, await savingsService.remove(req.couple!, req.userId!, req.params.id, req.params.entryId))));
