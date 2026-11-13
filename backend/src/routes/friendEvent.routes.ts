import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFriendsMember } from '../middleware/friendsContext.js';
import { validate } from '../middleware/validate.js';
import {
  expensiveReadLimiter,
  friendCommentLimiter,
  friendEventCreateLimiter,
  friendEventInviteLimiter,
  friendEventRsvpLimiter,
  friendEventUpdateLimiter,
  friendEventUploadLimiter,
} from '../middleware/rateLimit.js';
import {
  MAX_EVENT_DESCRIPTION,
  MAX_EVENT_INVITEES,
  MAX_EVENT_MAP_URL,
  MAX_EVENT_PLACE,
  MAX_EVENT_TITLE,
  RSVP_STATUSES,
} from '../models/FriendEvent.js';
import { MAX_COMMENT_BODY } from '../models/StoryComment.js';
import { friendEventService } from '../services/friendEvent.service.js';
import { STORY_IMAGE_TYPES } from '../services/story.service.js';
import { ok } from '../utils/response.js';

/** "Lên kèo" in the hidden friends space (BB5): events seen by their creator and the friends invited. */
export const friendEventRouter = Router();
friendEventRouter.use(requireAuth, requireFriendsMember);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });
const commentParams = z.object({ id: objectId, commentId: objectId });
const listQuery = z.object({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

/** ISO 8601 with an offset (the app sends UTC "…Z"). Stored in UTC. */
const instant = z.iso.datetime({ offset: true, message: 'Thời gian không hợp lệ' });
const coverSchema = z.object({
  key: z.string().min(1).max(300),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
});
// https only is checked again in the service (URL parsing); empty = no link.
const mapUrl = z
  .string()
  .trim()
  .max(MAX_EVENT_MAP_URL, 'Link bản đồ quá dài')
  .refine((s) => s === '' || /^https:\/\//i.test(s), 'Link bản đồ phải bắt đầu bằng https://');

const fields = {
  title: z.string().trim().min(1, 'Hãy đặt tên cho kèo').max(MAX_EVENT_TITLE, `Tên kèo tối đa ${MAX_EVENT_TITLE} ký tự`),
  startAt: instant,
  endAt: instant.nullable(),
  place: z.string().trim().max(MAX_EVENT_PLACE, `Địa điểm tối đa ${MAX_EVENT_PLACE} ký tự`),
  mapUrl: mapUrl.nullable(),
  description: z.string().max(MAX_EVENT_DESCRIPTION, `Mô tả tối đa ${MAX_EVENT_DESCRIPTION} ký tự`),
  cover: coverSchema.nullable(),
};
const inviteeIds = z.array(objectId).max(MAX_EVENT_INVITEES, `Mỗi kèo mời tối đa ${MAX_EVENT_INVITEES} người`);

const createSchema = z.object({
  title: fields.title,
  startAt: fields.startAt,
  endAt: fields.endAt.optional(),
  place: fields.place.default(''),
  mapUrl: fields.mapUrl.optional(),
  description: fields.description.default(''),
  cover: fields.cover.optional(),
  inviteeIds: inviteeIds.default([]),
});
/** PATCH: only what is sent changes; null clears endAt, mapUrl and cover. */
const updateSchema = z
  .object({
    title: fields.title.optional(),
    startAt: fields.startAt.optional(),
    endAt: fields.endAt.optional(),
    place: fields.place.optional(),
    mapUrl: fields.mapUrl.optional(),
    description: fields.description.optional(),
    cover: fields.cover.optional(),
  })
  .strict();
const inviteSchema = z.object({ userIds: inviteeIds.min(1, 'Hãy chọn ít nhất một người') });
const rsvpSchema = z.object({ status: z.enum(RSVP_STATUSES) });
const commentSchema = z.object({
  body: z.string().trim().min(1, 'Bình luận trống').max(MAX_COMMENT_BODY, 'Bình luận quá dài'),
  parentId: objectId.optional(),
});
const uploadSchema = z.object({
  mimeType: z.enum(Object.keys(STORY_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});

/** GET /api/friends/events?scope=upcoming|past&limit=1..50 → { items }; default 50, strip uses 3. */
friendEventRouter.get(
  '/',
  expensiveReadLimiter,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.list(req.friendsMember!, req.query.scope === 'past' ? 'past' : 'upcoming', Number(req.query.limit)))),
);

/** POST /api/friends/events/upload-url → presigned PUT for a cover photo. */
friendEventRouter.post(
  '/upload-url',
  friendEventUploadLimiter,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.createUploadUrl(req.friendsMember!, req.body.mimeType, req.body.sizeBytes), 201)),
);

/** POST /api/friends/events — 10 per day. */
friendEventRouter.post(
  '/',
  friendEventCreateLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.create(req.friendsMember!, req.body), 201)),
);

friendEventRouter.get(
  '/:id',
  expensiveReadLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.get(req.friendsMember!, req.params.id))),
);

/** PATCH /api/friends/events/:id — creator only, before the event is over. */
friendEventRouter.patch(
  '/:id',
  friendEventUpdateLimiter,
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.update(req.friendsMember!, req.params.id, req.body))),
);

/** DELETE /api/friends/events/:id — creator only; an upcoming event must be cancelled first. */
friendEventRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendEventService.remove(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** POST /api/friends/events/:id/invite { userIds } — creator only, their current friends, ≤ 100 in all. */
friendEventRouter.post(
  '/:id/invite',
  friendEventInviteLimiter,
  validate({ params: idParam, body: inviteSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.invite(req.friendsMember!, req.params.id, req.body.userIds))),
);

/** PUT /api/friends/events/:id/rsvp { status: going | maybe | declined } — invitees only. */
friendEventRouter.put(
  '/:id/rsvp',
  friendEventRsvpLimiter,
  validate({ params: idParam, body: rsvpSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.rsvp(req.friendsMember!, req.params.id, req.body.status))),
);

/** POST /api/friends/events/:id/cancel — creator only; tells everyone invited. */
friendEventRouter.post(
  '/:id/cancel',
  friendEventUpdateLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.cancel(req.friendsMember!, req.params.id))),
);

friendEventRouter.get(
  '/:id/comments',
  expensiveReadLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.listComments(req.friendsMember!, req.params.id))),
);

/** POST /api/friends/events/:id/comments { body, parentId? } — shares the 120 / hour comment limit with posts. */
friendEventRouter.post(
  '/:id/comments',
  friendCommentLimiter,
  validate({ params: idParam, body: commentSchema }),
  asyncHandler(async (req, res) => ok(res, await friendEventService.addComment(req.friendsMember!, req.params.id, req.body), 201)),
);

/** DELETE /api/friends/events/:id/comments/:commentId — comment author or event creator → { ok, removed }. */
friendEventRouter.delete(
  '/:id/comments/:commentId',
  validate({ params: commentParams }),
  asyncHandler(async (req, res) => {
    const { removed } = await friendEventService.deleteComment(req.friendsMember!, req.params.id, req.params.commentId);
    ok(res, { ok: true, removed });
  }),
);
