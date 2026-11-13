import { Router } from 'express';
import { expensiveReadLimiter } from '../middleware/rateLimit.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFriendsMember } from '../middleware/friendsContext.js';
import { validate } from '../middleware/validate.js';
import {
  friendBlockLimiter,
  friendInviteLimiter,
  friendReportLimiter,
  friendRequestLimiter,
  friendSearchLimiter,
  friendSuggestionDismissLimiter,
} from '../middleware/rateLimit.js';
import { REPORT_REASONS, REPORT_TARGETS } from '../models/FriendSafety.js';
import { MAX_FRIENDS_BIO } from '../models/User.js';
import { friendInviteService } from '../services/friendInvite.service.js';
import { friendNotificationsService } from '../services/friendNotifications.service.js';
import { friendSafetyService } from '../services/friendSafety.service.js';
import { friendStoryService } from '../services/friendStory.service.js';
import { friendSuggestionService } from '../services/friendSuggestion.service.js';
import { friendsService } from '../services/friends.service.js';
import { ok } from '../utils/response.js';

/** Hidden friends space ("Hội bạn bè"): friends, suggestions, notifications, profiles, safety, invite links. No couple needed. */
export const friendsRouter = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });
const userIdParam = z.object({ userId: objectId });
const searchQuery = z.object({ q: z.string().trim().min(1, 'Nhập tên hoặc email').max(100) });
const userBody = z.object({ userId: objectId });
// Lenient on purpose: a malformed code must not break the login; the service treats it as an invalid link.
const joinSchema = z.object({ inviteCode: z.string().max(40).optional() });
const notificationsQuery = z.object({ cursor: z.string().regex(/^\d{1,15}_[a-f\d]{24}$/i, 'Cursor không hợp lệ').optional() });
const storiesQuery = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
const offsetQuery = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0) });
const meSchema = z.object({ bio: z.string().trim().max(MAX_FRIENDS_BIO, `Giới thiệu tối đa ${MAX_FRIENDS_BIO} ký tự`) });
const reportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: objectId,
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(500, 'Ghi chú tối đa 500 ký tự').default(''),
});
const inviteSchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  maxUses: z.union([z.literal(1), z.literal(5), z.literal(20)]).default(5),
});

/** POST /api/friends/join { inviteCode? } — called after the hidden login; makes the caller a member (idempotent). */
friendsRouter.post(
  '/join',
  requireAuth,
  validate({ body: joinSchema }),
  asyncHandler(async (req, res) => ok(res, await friendsService.join(req.userId!, req.body.inviteCode))),
);

// Everything below needs a member of the friends space.
friendsRouter.use(requireAuth, requireFriendsMember);

/** GET /api/friends → { friends, incoming, outgoing } */
friendsRouter.get(
  '/', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await friendsService.overview(req.friendsMember!))),
);

/** GET /api/friends/unread → { notifications, friendRequests, messages } (navigation badges, polled). */
friendsRouter.get(
  '/unread', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await friendNotificationsService.unread(req.friendsMember!))),
);

/** GET /api/friends/search?q= — members by name (diacritics ignored) or exact email. */
friendsRouter.get(
  '/search', expensiveReadLimiter,
  friendSearchLimiter,
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => ok(res, await friendsService.search(req.friendsMember!, String(req.query.q)))),
);

// ── Friend suggestions (BB7) ──

/** GET /api/friends/suggestions → up to 20 [{ user, mutualCount, mutualPreview }], most mutual friends first. */
friendsRouter.get(
  '/suggestions', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await friendSuggestionService.list(req.friendsMember!))),
);

/** POST /api/friends/suggestions/:userId/dismiss — "Xóa": not suggested again for 90 days. */
friendsRouter.post(
  '/suggestions/:userId/dismiss',
  friendSuggestionDismissLimiter,
  validate({ params: userIdParam }),
  asyncHandler(async (req, res) => ok(res, await friendSuggestionService.dismiss(req.friendsMember!, req.params.userId))),
);

// ── Notifications (BB1) ──

friendsRouter.get(
  '/notifications', expensiveReadLimiter,
  validate({ query: notificationsQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    ok(res, await friendNotificationsService.list(req.friendsMember!, cursor));
  }),
);

friendsRouter.post(
  '/notifications/seen',
  asyncHandler(async (req, res) => {
    await friendNotificationsService.seen(req.friendsMember!);
    ok(res, { ok: true });
  }),
);

friendsRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    await friendNotificationsService.readAll(req.friendsMember!);
    ok(res, { ok: true });
  }),
);

friendsRouter.post(
  '/notifications/:id/read',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendNotificationsService.read(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);

// ── Profiles (BB3) ──

/** PATCH /api/friends/me { bio } — my friends-space bio. */
friendsRouter.patch(
  '/me',
  validate({ body: meSchema }),
  asyncHandler(async (req, res) => ok(res, await friendsService.updateMe(req.friendsMember!, req.body))),
);

friendsRouter.get(
  '/users/:id', expensiveReadLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendsService.profile(req.friendsMember!, req.params.id))),
);

/** GET /api/friends/users/:id/stories — only for that person and their friends (403 NOT_FRIENDS). */
friendsRouter.get(
  '/users/:id/stories', expensiveReadLimiter,
  validate({ params: idParam, query: storiesQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    ok(res, await friendStoryService.userStories(req.friendsMember!, req.params.id, cursor, Number(req.query.limit)));
  }),
);

friendsRouter.get(
  '/users/:id/friends', expensiveReadLimiter,
  validate({ params: idParam, query: offsetQuery }),
  asyncHandler(async (req, res) => ok(res, await friendsService.friendsOf(req.friendsMember!, req.params.id, Number(req.query.offset)))),
);

// ── Safety (BB2) ──

friendsRouter.get(
  '/blocks', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await friendSafetyService.listBlocked(req.friendsMember!))),
);

friendsRouter.post(
  '/blocks',
  friendBlockLimiter,
  validate({ body: userBody }),
  asyncHandler(async (req, res) => {
    await friendSafetyService.block(req.friendsMember!, req.body.userId);
    ok(res, { ok: true }, 201);
  }),
);

friendsRouter.delete(
  '/blocks/:userId',
  validate({ params: userIdParam }),
  asyncHandler(async (req, res) => {
    await friendSafetyService.unblock(req.friendsMember!, req.params.userId);
    ok(res, { ok: true });
  }),
);

/** POST /api/friends/reports { targetType, targetId, reason, note } */
friendsRouter.post(
  '/reports',
  friendReportLimiter,
  validate({ body: reportSchema }),
  asyncHandler(async (req, res) => ok(res, await friendSafetyService.report(req.friendsMember!, req.body), 201)),
);

// ── Invite links (BB4) ──

friendsRouter.get(
  '/invites', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await friendInviteService.list(req.friendsMember!))),
);

friendsRouter.post(
  '/invites',
  friendInviteLimiter,
  validate({ body: inviteSchema }),
  asyncHandler(async (req, res) => ok(res, await friendInviteService.create(req.friendsMember!, req.body.days, req.body.maxUses), 201)),
);

friendsRouter.delete(
  '/invites/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendInviteService.revoke(req.friendsMember!, req.params.id))),
);

// ── Friend requests ──

/** POST /api/friends/requests { userId } — send (or, if they already asked me, accept). */
friendsRouter.post(
  '/requests',
  friendRequestLimiter,
  validate({ body: userBody }),
  asyncHandler(async (req, res) => ok(res, await friendsService.sendRequest(req.friendsMember!, req.body.userId), 201)),
);

/** POST /api/friends/requests/:id/accept — recipient only. */
friendsRouter.post(
  '/requests/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendsService.accept(req.friendsMember!, req.params.id))),
);

/** DELETE /api/friends/requests/:id — decline (recipient) or cancel (requester). */
friendsRouter.delete(
  '/requests/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendsService.removeRequest(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** DELETE /api/friends/:userId — unfriend. Registered last: single-segment catch-all for DELETE. */
friendsRouter.delete(
  '/:userId',
  validate({ params: userIdParam }),
  asyncHandler(async (req, res) => {
    await friendsService.unfriend(req.friendsMember!, req.params.userId);
    ok(res, { ok: true });
  }),
);
