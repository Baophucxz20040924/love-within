import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { commentLimiter, storyCreateLimiter, storyUploadLimiter } from '../middleware/rateLimit.js';
import { MAX_STORY_BODY, MAX_STORY_PHOTOS, MAX_STORY_VIDEOS, MAX_STORY_VIDEO_BYTES, STORY_VIDEO_MIME_TYPES, MOODS, REACTION_TYPES } from '../models/Story.js';
import { MAX_COMMENT_BODY } from '../models/StoryComment.js';
import { STORY_IMAGE_TYPES, storyService } from '../services/story.service.js';
import { ok } from '../utils/response.js';

export const storyRouter = Router();
storyRouter.use(requireAuth, requireCouple);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });
const commentParams = z.object({ id: objectId, commentId: objectId });

const listQuery = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

const photoSchema = z.object({
  key: z.string().min(1).max(300),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
});

const videoSchema = photoSchema.extend({ mimeType: z.enum(STORY_VIDEO_MIME_TYPES) });
const videoUploadSchema = z.object({
  mimeType: z.enum(STORY_VIDEO_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_STORY_VIDEO_BYTES),
});

/** Full body/photos. Videos stay optional so old clients cannot erase them on edit. */
const contentSchema = z.object({
  body: z.string().max(MAX_STORY_BODY, 'Bài viết quá dài').default(''),
  mood: z.enum(MOODS).nullable().optional(),
  happenedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Ngày không hợp lệ')
    .nullable()
    .optional(),
  photos: z.array(photoSchema).max(MAX_STORY_PHOTOS, `Tối đa ${MAX_STORY_PHOTOS} ảnh`).default([]),
  videos: z.array(videoSchema).max(MAX_STORY_VIDEOS, `Tối đa ${MAX_STORY_VIDEOS} video`).optional(),
});

const uploadSchema = z.object({
  mimeType: z.enum(Object.keys(STORY_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});

const reactionSchema = z.object({ type: z.enum(REACTION_TYPES) });
const commentSchema = z.object({ body: z.string().trim().min(1, 'Bình luận trống').max(MAX_COMMENT_BODY, 'Bình luận quá dài') });

/** GET /api/stories?cursor=&limit= — feed, newest first. */
storyRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    ok(res, await storyService.feed(req.couple!, req.userId!, cursor, Number(req.query.limit)));
  }),
);

/** GET /api/stories/unread-count — partner's new posts + comments (nav badge). */
storyRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => ok(res, await storyService.unreadCount(req.couple!, req.userId!))),
);

/** POST /api/stories/seen — the caller opened the feed → { previousSeenAt }. */
storyRouter.post(
  '/seen',
  asyncHandler(async (req, res) => ok(res, await storyService.markSeen(req.userId!))),
);

/** GET /api/stories/on-this-day — "Ngày này năm xưa". */
storyRouter.get(
  '/on-this-day',
  asyncHandler(async (req, res) => ok(res, await storyService.onThisDay(req.couple!, req.userId!))),
);

/** POST /api/stories/upload-url → presigned PUT for one photo. */
storyRouter.post(
  '/upload-url',
  storyUploadLimiter,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await storyService.createUploadUrl(req.couple!, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

/** Separate cap/prefix, with exactly the same auth, couple context and upload limiter as photos. */
storyRouter.post(
  '/video-upload-url',
  storyUploadLimiter,
  validate({ body: videoUploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await storyService.createVideoUploadUrl(req.couple!, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

/** POST /api/stories — create a post. */
storyRouter.post(
  '/',
  storyCreateLimiter,
  validate({ body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await storyService.create(req.couple!, req.userId!, req.body), 201)),
);

storyRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await storyService.get(req.couple!, req.userId!, req.params.id))),
);

/** PATCH /api/stories/:id — author only; marks the post "Đã chỉnh sửa". */
storyRouter.patch(
  '/:id',
  validate({ params: idParam, body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await storyService.update(req.couple!, req.userId!, req.params.id, req.body))),
);

/** DELETE /api/stories/:id — author only (soft delete). */
storyRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await storyService.remove(req.couple!, req.userId!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** PUT /api/stories/:id/reaction { type } — set or change my reaction. */
storyRouter.put(
  '/:id/reaction',
  validate({ params: idParam, body: reactionSchema }),
  asyncHandler(async (req, res) => ok(res, await storyService.react(req.couple!, req.userId!, req.params.id, req.body.type))),
);

/** DELETE /api/stories/:id/reaction — remove my reaction. */
storyRouter.delete(
  '/:id/reaction',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await storyService.react(req.couple!, req.userId!, req.params.id, null))),
);

storyRouter.get(
  '/:id/comments',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await storyService.listComments(req.couple!, req.userId!, req.params.id))),
);

storyRouter.post(
  '/:id/comments',
  commentLimiter,
  validate({ params: idParam, body: commentSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await storyService.addComment(req.couple!, req.userId!, req.params.id, req.body.body), 201);
  }),
);

/** DELETE /api/stories/:id/comments/:commentId — comment author only. */
storyRouter.delete(
  '/:id/comments/:commentId',
  validate({ params: commentParams }),
  asyncHandler(async (req, res) => {
    await storyService.deleteComment(req.couple!, req.userId!, req.params.id, req.params.commentId);
    ok(res, { ok: true });
  }),
);
