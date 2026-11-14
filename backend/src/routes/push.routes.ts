import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { pushSubscribeLimiter, pushTestLimiter } from '../middleware/rateLimit.js';
import { PUSH_SPACES } from '../models/PushSubscription.js';
import { pushService } from '../services/push.service.js';
import { ok } from '../utils/response.js';

/**
 * Web Push (plan/OPERATIONS.md, N4). Login needed, no couple: mounted before the '/api' routers that require one.
 * `space` is the session's space; 'friends' needs a member of the friends space (403 FRIENDS_NOT_JOINED).
 */
export const pushRouter = Router();
pushRouter.use(requireAuth);

const space = z.enum(PUSH_SPACES);
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Khóa không hợp lệ');
const endpoint = z.string().min(1).max(1000);
const subscribeSchema = z.object({
  endpoint,
  keys: z.object({ p256dh: base64Url.min(80).max(100), auth: base64Url.min(16).max(32) }),
  space,
});
const endpointSchema = z.object({ endpoint });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Giờ phải có dạng HH:mm');
const quiet = z.strictObject({ enabled: z.boolean().optional(), from: hhmm.optional(), to: hhmm.optional() }).optional();
const settingsPatch = z.discriminatedUnion('space', [
  z.strictObject({
    space: z.literal('couple'),
    groups: z
      .strictObject({
        approvals: z.boolean().optional(),
        stories: z.boolean().optional(),
        reminders: z.boolean().optional(),
        nudges: z.boolean().optional(),
        moments: z.boolean().optional(),
      })
      .optional(),
    preview: z.boolean().optional(),
    quiet,
  }),
  z.strictObject({
    space: z.literal('friends'),
    groups: z.strictObject({ social: z.boolean().optional(), events: z.boolean().optional(), messages: z.boolean().optional() }).optional(),
    preview: z.boolean().optional(),
    quiet,
  }),
]);
const settingsQuery = z.object({ space });

/** GET /api/push/config → { enabled, publicKey } (VAPID public key for PushManager.subscribe). */
pushRouter.get('/config', (_req, res) => {
  ok(res, pushService.config());
});

/** POST /api/push/subscriptions { endpoint, keys: { p256dh, auth }, space } — this device, upsert by endpoint. */
pushRouter.post(
  '/subscriptions',
  pushSubscribeLimiter,
  validate({ body: subscribeSchema }),
  asyncHandler(async (req, res) => ok(res, await pushService.subscribe(req.userId!, req.body, req.headers['user-agent']), 201)),
);

/** DELETE /api/push/subscriptions { endpoint } — logout / switch off; only the caller's own device. */
pushRouter.delete(
  '/subscriptions',
  validate({ body: endpointSchema }),
  asyncHandler(async (req, res) => ok(res, await pushService.unsubscribe(req.userId!, req.body.endpoint))),
);

/** GET /api/push/settings?space=couple|friends → { space, groups, preview, quiet } (only that space's groups). */
pushRouter.get(
  '/settings',
  validate({ query: settingsQuery }),
  asyncHandler(async (req, res) => ok(res, await pushService.getSettings(req.userId!, req.query.space as 'couple' | 'friends'))),
);

/** PATCH /api/push/settings { space, groups?, preview?, quiet? } */
pushRouter.patch(
  '/settings',
  validate({ body: settingsPatch }),
  asyncHandler(async (req, res) => ok(res, await pushService.updateSettings(req.userId!, req.body))),
);

/** POST /api/push/test { endpoint } — a test push to this device only; 5 / hour. */
pushRouter.post(
  '/test',
  pushTestLimiter,
  validate({ body: endpointSchema }),
  asyncHandler(async (req, res) => ok(res, await pushService.test(req.userId!, req.body.endpoint))),
);
