import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireFriendsMember } from '../middleware/friendsContext.js';
import { expensiveReadLimiter, outingsWriteLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { ok } from '../utils/response.js';
import { friendOutingService } from '../services/friendOuting.service.js';
import { outingObjectId, outingSchemas, type OutingMutationKind } from '../services/friendOuting.validation.js';

/** Mount before generic friends/wallet routers. Charge only matched routes, after authentication. */
export const friendOutingRouter = Router();
friendOutingRouter.use(requireAuth, requireFriendsMember);
const idParams = z.object({ id: outingObjectId });
friendOutingRouter.get('/', expensiveReadLimiter, validate({ query: outingSchemas.list }), asyncHandler(async (req, res) =>
  ok(res, await friendOutingService.list(req.friendsMember!, req.query as unknown as z.infer<typeof outingSchemas.list>))));
friendOutingRouter.post('/', outingsWriteLimiter, validate({ body: outingSchemas.create }), asyncHandler(async (req, res) =>
  ok(res, await friendOutingService.create(req.friendsMember!, req.body), 201)));
friendOutingRouter.get('/:id', expensiveReadLimiter, validate({ params: idParams }), asyncHandler(async (req, res) =>
  ok(res, await friendOutingService.get(req.friendsMember!, req.params.id))));
friendOutingRouter.delete('/:id', outingsWriteLimiter, validate({ params: idParams, body: outingSchemas.simple }), asyncHandler(async (req, res) =>
  ok(res, await friendOutingService.delete(req.friendsMember!, req.params.id, req.body))));

function mutation(path: string, kind: OutingMutationKind, body: z.ZodType, target?: 'expenseId' | 'settlementId', method: 'post' | 'patch' = 'post') {
  const params = target ? idParams.extend({ [target]: outingObjectId }) : idParams;
  friendOutingRouter[method](path, outingsWriteLimiter, validate({ params, body }), asyncHandler(async (req, res) =>
    ok(res, await friendOutingService.mutate(req.friendsMember!, req.params.id, kind, req.body, target ? req.params[target] : undefined))));
}
mutation('/:id/members/invite', 'invite', outingSchemas.invite);
mutation('/:id/members/accept', 'accept', outingSchemas.simple);
mutation('/:id/members/decline', 'decline', outingSchemas.simple);
mutation('/:id/expenses', 'expense_create', outingSchemas.expense);
mutation('/:id/expenses/:expenseId', 'expense_edit', outingSchemas.expenseEdit, 'expenseId', 'patch');
mutation('/:id/expenses/:expenseId/void', 'expense_void', outingSchemas.simple, 'expenseId');
mutation('/:id/close-review', 'close_review', outingSchemas.simple);
mutation('/:id/approve', 'approve', outingSchemas.consent);
mutation('/:id/object', 'object', outingSchemas.consent);
mutation('/:id/settlements', 'settlement_create', outingSchemas.settlement);
mutation('/:id/settlements/:settlementId/confirm', 'settlement_confirm', outingSchemas.simple, 'settlementId');
mutation('/:id/settlements/:settlementId/reject', 'settlement_reject', outingSchemas.simple, 'settlementId');
mutation('/:id/settlements/:settlementId/cancel', 'settlement_cancel', outingSchemas.simple, 'settlementId');
mutation('/:id/complete', 'complete', outingSchemas.simple);
