import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { privacyLockService } from '../services/privacyLock.service.js';
import { fail, ok } from '../utils/response.js';

export const privacyLockRouter = Router();
const space = z.enum(['couple', 'friends']);
const pin = z.string().regex(/^[0-9]{6}$/, 'Mã phải gồm đúng 6 chữ số.');
const password = z.string().min(1).max(1024);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const params = z.object({ space });
const unlockBody = z.object({ pin }).strict();
const putBody = z.object({ pin, password, revision }).strict();
const deleteBody = z.object({ password, revision }).strict();

// Additional per-worker IP cost ceiling; the durable account budget is enforced in the service.
const workLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader('Retry-After', '60');
    fail(res, 429, 'TOO_MANY_REQUESTS', 'Thao tác quá nhanh, vui lòng thử lại sau.', { retryAfterSeconds: 60 });
  },
});

privacyLockRouter.use(requireAuth);
privacyLockRouter.get('/', asyncHandler(async (req, res) => ok(res, await privacyLockService.status(req.userId!))));
privacyLockRouter.post('/unlock', workLimiter, validate({ body: unlockBody }), asyncHandler(async (req, res) =>
  ok(res, await privacyLockService.unlock(req.userId!, req.body.pin))));
privacyLockRouter.put('/:space', workLimiter, validate({ params, body: putBody }), asyncHandler(async (req, res) =>
  ok(res, await privacyLockService.configure(req.userId!, space.parse(req.params.space), req.body.password, req.body.revision, req.body.pin))));
privacyLockRouter.delete('/:space', workLimiter, validate({ params, body: deleteBody }), asyncHandler(async (req, res) =>
  ok(res, await privacyLockService.configure(req.userId!, space.parse(req.params.space), req.body.password, req.body.revision))));
