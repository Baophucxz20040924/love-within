import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { expensiveReadLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { coupleNotificationsService, MAX_NOTIFICATION_WATERMARKS } from '../services/coupleNotifications.service.js';
import { ok } from '../utils/response.js';

/** Mount at /api/notifications. Service validates current active couple membership on every endpoint. */
export const coupleNotificationsRouter = Router();
coupleNotificationsRouter.use(requireAuth);
const watermark = z.string().regex(/^[a-f\d]{64}$/);
const acknowledgement = z.union([
  z.object({ watermark }).strict().transform(({ watermark: token }) => ({ watermarks: [token] })),
  z.object({ watermarks: z.array(watermark).min(1).max(MAX_NOTIFICATION_WATERMARKS) }).strict(),
]);
coupleNotificationsRouter.get('/', expensiveReadLimiter,
  validate({ query: z.object({ cursor: z.string().max(64).regex(/^\d{1,15}_[a-f\d]{24}$/i).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await coupleNotificationsService.list(req.userId!, req.query.cursor as string | undefined))));
coupleNotificationsRouter.get('/unread', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await coupleNotificationsService.unread(req.userId!))));
coupleNotificationsRouter.post('/seen', validate({ body: acknowledgement }), asyncHandler(async (req, res) => {
  await coupleNotificationsService.seen(req.userId!, req.body.watermarks);
  ok(res, { ok: true });
}));
coupleNotificationsRouter.post('/read-all', validate({ body: acknowledgement }), asyncHandler(async (req, res) => {
  await coupleNotificationsService.readAll(req.userId!, req.body.watermarks);
  ok(res, { ok: true });
}));
coupleNotificationsRouter.post('/:id/read', validate({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }) }),
  asyncHandler(async (req, res) => {
    await coupleNotificationsService.read(req.userId!, req.params.id);
    ok(res, { ok: true });
  }));
