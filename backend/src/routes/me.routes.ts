import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { avatarUploadLimiter } from '../middleware/rateLimit.js';
import { meController } from '../controllers/me.controller.js';
import { AVATAR_IMAGE_TYPES, avatarService } from '../services/avatar.service.js';
import { ok } from '../utils/response.js';

export const meRouter = Router();

const avatarUploadSchema = z.object({
  mimeType: z.enum(Object.keys(AVATAR_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});
const avatarSetSchema = z.object({ key: z.string().min(1).max(300) });

meRouter.get('/me', requireAuth, asyncHandler(meController.get));

/** POST /api/me/avatar/upload-url → presigned PUT for a profile photo (≤ 1 MB). */
meRouter.post(
  '/me/avatar/upload-url',
  requireAuth,
  avatarUploadLimiter,
  validate({ body: avatarUploadSchema }),
  asyncHandler(async (req, res) => ok(res, await avatarService.createUploadUrl(req.userId!, req.body.mimeType, req.body.sizeBytes), 201)),
);

/** PUT /api/me/avatar { key } — use an uploaded photo (both spaces). */
meRouter.put(
  '/me/avatar',
  requireAuth,
  validate({ body: avatarSetSchema }),
  asyncHandler(async (req, res) => ok(res, await avatarService.set(req.userId!, req.body.key))),
);

/** DELETE /api/me/avatar — back to the initial-letter avatar. */
meRouter.delete(
  '/me/avatar',
  requireAuth,
  asyncHandler(async (req, res) => ok(res, await avatarService.remove(req.userId!))),
);
