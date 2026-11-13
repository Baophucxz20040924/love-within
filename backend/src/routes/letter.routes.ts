import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { letterCreateLimiter, letterUploadLimiter } from '../middleware/rateLimit.js';
import { MAX_LETTER_BODY, MAX_LETTER_PHOTOS, MAX_LETTER_TITLE } from '../models/CoupleLetter.js';
import { letterService } from '../services/letter.service.js';
import { STORY_IMAGE_TYPES } from '../services/story.service.js';
import { isRealDate } from '../utils/date.js';
import { ok } from '../utils/response.js';

/** "Thư hẹn giờ" (plan/COUPLE_V2_PLAN.md, CP2). The sealing rules live in letter.service.ts. */
export const letterRouter = Router();
letterRouter.use(requireAuth, requireCouple);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });

const photoSchema = z.object({
  key: z.string().min(1).max(300),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
});

/** Full letter (create and edit: the composer always sends everything). The open-date range is checked in the service. */
const contentSchema = z.object({
  title: z.string().trim().max(MAX_LETTER_TITLE, `Tiêu đề tối đa ${MAX_LETTER_TITLE} ký tự`).default(''),
  body: z.string().trim().min(1, 'Hãy viết vài dòng cho người ấy').max(MAX_LETTER_BODY, 'Thư quá dài'),
  openOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày mở phải có dạng YYYY-MM-DD')
    .refine(isRealDate, 'Ngày mở không có thật'),
  photos: z.array(photoSchema).max(MAX_LETTER_PHOTOS, `Tối đa ${MAX_LETTER_PHOTOS} ảnh`).default([]),
});

const uploadSchema = z.object({
  mimeType: z.enum(Object.keys(STORY_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});

/** GET /api/letters → { inbox, sent }; letters to me carry no title before the open time, and no body or photos ever. */
letterRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await letterService.list(req.couple!, req.userId!))),
);

/** POST /api/letters/upload-url → presigned PUT for one photo (key under couples/<coupleId>/letters/). */
letterRouter.post(
  '/upload-url',
  letterUploadLimiter,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await letterService.createUploadUrl(req.couple!, req.body.mimeType, req.body.sizeBytes), 201);
  }),
);

/** POST /api/letters — to the partner; 10 per day per user. */
letterRouter.post(
  '/',
  letterCreateLimiter,
  validate({ body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await letterService.create(req.couple!, req.userId!, req.body), 201)),
);

/** GET /api/letters/:id — author always; recipient: 403 LETTER_SEALED before the open time, content after the first open. */
letterRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await letterService.get(req.couple!, req.userId!, req.params.id))),
);

/** PATCH /api/letters/:id — author only, until opened (409 LETTER_OPENED). */
letterRouter.patch(
  '/:id',
  validate({ params: idParam, body: contentSchema }),
  asyncHandler(async (req, res) => ok(res, await letterService.update(req.couple!, req.userId!, req.params.id, req.body))),
);

/** DELETE /api/letters/:id — author only, until opened (soft delete). */
letterRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await letterService.remove(req.couple!, req.userId!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** POST /api/letters/:id/open — recipient only, after the open time; idempotent (openedAt written once). */
letterRouter.post(
  '/:id/open',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await letterService.open(req.couple!, req.userId!, req.params.id))),
);
