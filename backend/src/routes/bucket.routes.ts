import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { bucketCreateLimiter } from '../middleware/rateLimit.js';
import {
  BUCKET_CATEGORIES,
  BUCKET_DATE_MAX,
  BUCKET_DATE_MIN,
  BUCKET_STATUSES,
  MAX_BUCKET_EMOJI,
  MAX_BUCKET_NOTE,
  MAX_BUCKET_TITLE,
} from '../models/BucketItem.js';
import { MAX_STORY_PHOTOS } from '../models/Story.js';
import { bucketService } from '../services/bucket.service.js';
import { isRealDate } from '../utils/date.js';
import { ok } from '../utils/response.js';

/** "Bucket list chung" (plan/ENGINEERING_WORKFLOW.md, CP3). Either member edits, deletes or completes any item. */
export const bucketRouter = Router();
bucketRouter.use(requireAuth, requireCouple);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD')
  .refine(isRealDate, 'Ngày không có thật')
  .refine((d) => d >= BUCKET_DATE_MIN && d <= BUCKET_DATE_MAX, 'Ngày phải trong khoảng năm 2000 tới 2100');

// No defaults here: the same fields serve the partial edit, where a missing field must stay unchanged.
const fields = {
  title: z.string().trim().min(1, 'Hãy đặt tên cho mục này').max(MAX_BUCKET_TITLE, `Tên tối đa ${MAX_BUCKET_TITLE} ký tự`),
  emoji: z
    .string()
    .trim()
    .min(1, 'Hãy chọn biểu tượng')
    .max(MAX_BUCKET_EMOJI, 'Biểu tượng quá dài')
    .regex(/^\S+$/u, 'Biểu tượng không hợp lệ'),
  category: z.enum(BUCKET_CATEGORIES),
  note: z.string().trim().max(MAX_BUCKET_NOTE, `Ghi chú tối đa ${MAX_BUCKET_NOTE} ký tự`),
  dueOn: day.nullable(),
  pinned: z.boolean(),
};

const createSchema = z
  .object({
    title: fields.title.optional(),
    emoji: fields.emoji.optional(),
    category: fields.category.optional(),
    note: fields.note.optional(),
    dueOn: fields.dueOn.optional(),
    pinned: fields.pinned.optional(),
    ideaId: z.string().regex(/^b\d{3,4}$/, 'Gợi ý không hợp lệ').optional(),
  })
  .refine((o) => o.title !== undefined || o.ideaId !== undefined, { message: 'Hãy đặt tên cho mục này', path: ['title'] });

const updateSchema = z
  .object({
    title: fields.title.optional(),
    emoji: fields.emoji.optional(),
    category: fields.category.optional(),
    note: fields.note.optional(),
    dueOn: fields.dueOn.optional(),
    pinned: fields.pinned.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Không có gì để cập nhật');

const listQuery = z.object({ status: z.enum(BUCKET_STATUSES).default('todo') });

const photoSchema = z.object({
  key: z.string().min(1).max(300),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
});

const completeSchema = z.object({
  /** Default today (couple timezone). Not in the future, not more than 30 days before the item was added (service). */
  doneOn: day.nullable().optional(),
  /** "Cảm nhận": also the text of the story. */
  note: z.string().trim().max(MAX_BUCKET_NOTE, `Cảm nhận tối đa ${MAX_BUCKET_NOTE} ký tự`).default(''),
  photos: z.array(photoSchema).max(MAX_STORY_PHOTOS, `Tối đa ${MAX_STORY_PHOTOS} ảnh`).default([]),
  postStory: z.boolean().default(true),
});

/** GET /api/bucket?status=todo|done → { status, items, counts: { todo, done } }. */
bucketRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => ok(res, await bucketService.list(req.couple!, req.query.status as 'todo' | 'done'))),
);

/** GET /api/bucket/ideas → { categories, ideas: [{ id, title, emoji, category, added }] }. */
bucketRouter.get(
  '/ideas',
  asyncHandler(async (req, res) => ok(res, await bucketService.ideas(req.couple!))),
);

/** POST /api/bucket — 50 per day per user. `{ ideaId }` alone adds a suggestion as it is. */
bucketRouter.post(
  '/',
  bucketCreateLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => ok(res, await bucketService.create(req.couple!, req.userId!, req.body), 201)),
);

/** PATCH /api/bucket/:id — either member; any subset of the fields (also pin / unpin). */
bucketRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => ok(res, await bucketService.update(req.couple!, req.userId!, req.params.id, req.body))),
);

/** DELETE /api/bucket/:id — either member (soft delete; POST /:id/restore undoes it). */
bucketRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await bucketService.remove(req.couple!, req.userId!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** POST /api/bucket/:id/restore — "Hoàn tác" a delete. */
bucketRouter.post(
  '/:id/restore',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await bucketService.restore(req.couple!, req.userId!, req.params.id))),
);

/** POST /api/bucket/:id/complete { doneOn, note, photos, postStory } → { item, story, reward, rewardSkipped }. */
bucketRouter.post(
  '/:id/complete',
  validate({ params: idParam, body: completeSchema }),
  asyncHandler(async (req, res) => ok(res, await bucketService.complete(req.couple!, req.userId!, req.params.id, req.body))),
);

/** POST /api/bucket/:id/reopen — within 24 h of marking it done. */
bucketRouter.post(
  '/:id/reopen',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await bucketService.reopen(req.couple!, req.userId!, req.params.id))),
);
