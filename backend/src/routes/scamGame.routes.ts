import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireFriendsMember } from '../middleware/friendsContext.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { expensiveReadLimiter, scamMessageLimiter, scamWriteLimiter } from '../middleware/rateLimit.js';
import { scamGameService } from '../services/scamGame.service.js';
import { ok } from '../utils/response.js';

export const scamGameRouter = Router();
scamGameRouter.use(requireAuth, requireFriendsMember);
const base = z.object({ operationId: z.uuid(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const match = base.extend({ matchId: z.uuid() });
scamGameRouter.get('/state', expensiveReadLimiter, asyncHandler(async (req, res) => ok(res, await scamGameService.state(req.friendsMember!._id))));
scamGameRouter.get('/leaderboard', expensiveReadLimiter, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1024).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await scamGameService.leaderboard(req.friendsMember!._id, Number(req.query.limit), req.query.cursor as string | undefined))));
scamGameRouter.post('/start', scamWriteLimiter, validate({ body: base.extend({ consent: z.literal(true) }) }),
  asyncHandler(async (req, res) => ok(res, await scamGameService.start(req.friendsMember!._id, req.body))));
scamGameRouter.post('/message', scamMessageLimiter, validate({ body: match.extend({ text: z.string().trim().min(1).max(1200) }) }),
  asyncHandler(async (req, res) => ok(res, await scamGameService.message(req.friendsMember!._id, req.body, req.body.text))));
scamGameRouter.post('/verify', scamWriteLimiter, validate({ body: match.extend({ stage: z.enum(['account', 'password', 'otp']), value: z.string().min(1).max(100) }) }),
  asyncHandler(async (req, res) => ok(res, await scamGameService.verify(req.friendsMember!._id, req.body, req.body.stage, req.body.value))));
scamGameRouter.post('/stop', scamWriteLimiter, validate({ body: match }),
  asyncHandler(async (req, res) => ok(res, await scamGameService.stop(req.friendsMember!._id, req.body))));
