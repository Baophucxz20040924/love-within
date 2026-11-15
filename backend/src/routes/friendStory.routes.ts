import { Router } from 'express';
import { expensiveReadLimiter } from '../middleware/rateLimit.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFriendsMember } from '../middleware/friendsContext.js';
import { validate } from '../middleware/validate.js';
import {
  friendCommentLimiter,
  friendMentionLimiter,
  friendPollVoteLimiter,
  friendPollVotersLimiter,
  friendStoryCreateLimiter,
  friendStoryUploadLimiter,
} from '../middleware/rateLimit.js';
import { MAX_POLL_OPTION, POLL_DURATION_DAYS, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from '../models/FriendStory.js';
import { MAX_MENTIONS } from '../models/FriendStoryComment.js';
import { MAX_STORY_BODY, MAX_STORY_PHOTOS, MAX_STORY_VIDEOS, MAX_STORY_VIDEO_BYTES, STORY_VIDEO_MIME_TYPES, REACTION_TYPES } from '../models/Story.js';
import { MAX_COMMENT_BODY } from '../models/StoryComment.js';
import { friendStoryService } from '../services/friendStory.service.js';
import { friendSafetyService } from '../services/friendSafety.service.js';
import { STORY_IMAGE_TYPES } from '../services/story.service.js';
import { ok } from '../utils/response.js';

/** Hidden friends space: Facebook-style posts seen by the author's friends. */
export const friendStoryRouter = Router();
friendStoryRouter.use(requireAuth, requireFriendsMember);

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
  photos: z.array(photoSchema).max(MAX_STORY_PHOTOS, `Tối đa ${MAX_STORY_PHOTOS} ảnh`).default([]),
  videos: z.array(videoSchema).max(MAX_STORY_VIDEOS, `Tối đa ${MAX_STORY_VIDEOS} video`).optional(),
  mentions: z.array(z.object({
    userId: objectId,
    offset: z.number().int().min(0).max(MAX_STORY_BODY),
    length: z.number().int().min(2).max(MAX_STORY_BODY),
  })).max(MAX_MENTIONS, `Nhắc tối đa ${MAX_MENTIONS} người`).optional(),
  /** BB6. Edit: left out = keep the poll; null = remove it (only without votes). `durationDays` left out on edit = keep the deadline. */
  poll: z
    .object({
      options: z
        .array(z.string().trim().min(1, 'Lựa chọn trống').max(MAX_POLL_OPTION, `Mỗi lựa chọn tối đa ${MAX_POLL_OPTION} ký tự`))
        .min(POLL_MIN_OPTIONS, `Bình chọn cần ít nhất ${POLL_MIN_OPTIONS} lựa chọn`)
        .max(POLL_MAX_OPTIONS, `Tối đa ${POLL_MAX_OPTIONS} lựa chọn`),
      multi: z.boolean().default(false),
      durationDays: z
        .number()
        .int()
        .refine((d) => (POLL_DURATION_DAYS as readonly number[]).includes(d), 'Thời hạn không hợp lệ')
        .optional(),
    })
    .nullable()
    .optional(),
});

const optionId = z.string().regex(/^[a-f\d]{8}$/i, 'Lựa chọn không hợp lệ');
/** PUT vote: the whole choice (one id for a single-choice poll). Taking the vote back is DELETE. */
const voteSchema = z.object({
  optionIds: z.array(optionId).min(1, 'Hãy chọn ít nhất một lựa chọn').max(POLL_MAX_OPTIONS),
});
const votersQuery = z.object({ option: optionId });
const reactionsQuery = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const uploadSchema = z.object({
  mimeType: z.enum(Object.keys(STORY_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});

const reactionSchema = z.object({ type: z.enum(REACTION_TYPES) });
const mentionSchema = z.object({
  userId: objectId,
  offset: z.number().int().min(0).max(MAX_COMMENT_BODY),
  length: z.number().int().min(2).max(MAX_COMMENT_BODY),
});
/** BB8: `parentId` = the comment answered (a reply to a reply goes under its root); `mentions` = "@Tên" spans of the trimmed body. */
const commentSchema = z.object({
  body: z.string().trim().min(1, 'Bình luận trống').max(MAX_COMMENT_BODY, 'Bình luận quá dài'),
  parentId: objectId.optional(),
  mentions: z.array(mentionSchema).max(MAX_MENTIONS, `Nhắc tối đa ${MAX_MENTIONS} người`).default([]),
});
const mentionableQuery = z.object({ q: z.string().trim().max(60).default('') });

/** GET /api/friends/stories?cursor=&limit= — my posts + friends' posts, newest first. */
friendStoryRouter.get(
  '/', expensiveReadLimiter,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    ok(res, await friendStoryService.feed(req.friendsMember!, cursor, Number(req.query.limit)));
  }),
);

/** POST /api/friends/stories/upload-url → presigned PUT for one photo. */
friendStoryRouter.post(
  '/upload-url',
  friendStoryUploadLimiter,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await friendStoryService.createUploadUrl(req.friendsMember!, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

/** Separate cap/prefix, with exactly the same auth, membership and upload limiter as photos. */
friendStoryRouter.post(
  '/video-upload-url',
  friendStoryUploadLimiter,
  validate({ body: videoUploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await friendStoryService.createVideoUploadUrl(req.friendsMember!, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

friendStoryRouter.post(
  '/',
  friendStoryCreateLimiter,
  validate({ body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.create(req.friendsMember!, req.body), 201)),
);

/** Draft composer picker, before the dynamic post route. */
friendStoryRouter.get(
  '/mentionable', expensiveReadLimiter, friendMentionLimiter,
  validate({ query: mentionableQuery }),
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    ok(res, await friendStoryService.draftMentionable(req.friendsMember!, q));
  }),
);

friendStoryRouter.get(
  '/:id', expensiveReadLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.get(req.friendsMember!, req.params.id))),
);

/** PATCH /api/friends/stories/:id — author only; marks the post "Đã chỉnh sửa". */
friendStoryRouter.patch(
  '/:id',
  validate({ params: idParam, body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.update(req.friendsMember!, req.params.id, req.body))),
);

/** DELETE /api/friends/stories/:id — author only (soft delete). */
friendStoryRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendStoryService.remove(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** GET reactions in stable user-ID order, excluding profiles blocked either way. */
friendStoryRouter.get(
  '/:id/reactions', expensiveReadLimiter,
  validate({ params: idParam, query: reactionsQuery }),
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    ok(res, await friendStoryService.reactions(req.friendsMember!, req.params.id, cursor, Number(req.query.limit)));
  }),
);

friendStoryRouter.put(
  '/:id/reaction',
  validate({ params: idParam, body: reactionSchema }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.react(req.friendsMember!, req.params.id, req.body.type))),
);

friendStoryRouter.delete(
  '/:id/reaction',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.react(req.friendsMember!, req.params.id, null))),
);

/** PUT /api/friends/stories/:id/vote { optionIds } — choose or change my vote (BB6); after the deadline → 409 POLL_CLOSED. */
friendStoryRouter.put(
  '/:id/vote',
  friendPollVoteLimiter,
  validate({ params: idParam, body: voteSchema }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.vote(req.friendsMember!, req.params.id, req.body.optionIds))),
);

/** DELETE /api/friends/stories/:id/vote — take my vote back while the poll is open. */
friendStoryRouter.delete(
  '/:id/vote',
  friendPollVoteLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.unvote(req.friendsMember!, req.params.id))),
);

/** GET /api/friends/stories/:id/poll/voters?option= → { option, count, items } (newest first, ≤ 500, without blocked people). */
friendStoryRouter.get(
  '/:id/poll/voters', expensiveReadLimiter,
  friendPollVotersLimiter,
  validate({ params: idParam, query: votersQuery }),
  asyncHandler(async (req, res) => {
    ok(res, await friendStoryService.pollVoters(req.friendsMember!, req.params.id, String(req.query.option)));
  }),
);

/** GET /api/friends/stories/:id/comments → root comments (oldest first) with `replies[]`, at most 500 comments in all. */
friendStoryRouter.get(
  '/:id/comments', expensiveReadLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await friendStoryService.listComments(req.friendsMember!, req.params.id))),
);

/** POST /api/friends/stories/:id/comments { body, parentId?, mentions? } */
friendStoryRouter.post(
  '/:id/comments',
  friendCommentLimiter,
  validate({ params: idParam, body: commentSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await friendStoryService.addComment(req.friendsMember!, req.params.id, req.body), 201);
  }),
);

/** GET /api/friends/stories/:id/mentionable?q= — "@" picker: up to 10 people who can see the post. */
friendStoryRouter.get(
  '/:id/mentionable', expensiveReadLimiter,
  friendMentionLimiter,
  validate({ params: idParam, query: mentionableQuery }),
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    ok(res, await friendStoryService.mentionable(req.friendsMember!, req.params.id, q));
  }),
);

/** DELETE /api/friends/stories/:id/comments/:commentId — comment author or post author; a root takes its replies along → { removed }. */
friendStoryRouter.delete(
  '/:id/comments/:commentId',
  validate({ params: commentParams }),
  asyncHandler(async (req, res) => {
    const { removed } = await friendStoryService.deleteComment(req.friendsMember!, req.params.id, req.params.commentId);
    ok(res, { ok: true, removed });
  }),
);

/** POST /api/friends/stories/:id/hide — hide a friend's post from my feed (BB2). DELETE undoes it. */
friendStoryRouter.post(
  '/:id/hide',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendSafetyService.hideStory(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);

friendStoryRouter.delete(
  '/:id/hide',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await friendSafetyService.unhideStory(req.friendsMember!, req.params.id);
    ok(res, { ok: true });
  }),
);
