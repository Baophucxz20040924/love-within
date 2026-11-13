import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { invitePreviewLimiter } from '../middleware/rateLimit.js';
import { friendInviteService } from '../services/friendInvite.service.js';
import { ok } from '../utils/response.js';

/** Endpoints that work without logging in. Keep this list short. */
export const publicRouter = Router();

/** GET /api/public/invites/:code → { valid, inviter? { displayName, avatarUrl } } (landing page of /j/<code>). */
publicRouter.get(
  '/invites/:code',
  invitePreviewLimiter,
  asyncHandler(async (req, res) => ok(res, await friendInviteService.preview(String(req.params.code)))),
);
