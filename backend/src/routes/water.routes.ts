import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { uploadUrlLimiter, waterManualLimiter, waterPhotoLimiter } from '../middleware/rateLimit.js';
import { ALLOWED_IMAGE_TYPES, MAX_MANUAL_ML, waterService } from '../services/water.service.js';
import { proposalService } from '../services/proposal.service.js';
import { waterGoalPayloadSchema } from '../services/proposalHandlers/waterGoal.handler.js';
import { ok } from '../utils/response.js';

export const waterRouter = Router();
waterRouter.use(requireAuth, requireCouple);

const logIdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ') });

/** GET /api/water/today — caller's approved total, pending ml and today's logs. */
waterRouter.get(
  '/today',
  asyncHandler(async (req, res) => {
    ok(res, await waterService.today(req.couple!, req.userId!));
  }),
);

/** GET /api/water/pending — submissions of both members waiting for approval. */
waterRouter.get(
  '/pending',
  asyncHandler(async (req, res) => {
    ok(res, await waterService.pending(req.couple!));
  }),
);

/** POST /api/water/goal/propose — dual-approval water goal. */
waterRouter.post(
  '/goal/propose',
  validate({ body: waterGoalPayloadSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await proposalService.create(req.couple!, req.userId!, 'water_goal', req.body), 201);
  }),
);

const uploadUrlSchema = z.object({
  mimeType: z.enum(Object.keys(ALLOWED_IMAGE_TYPES) as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
  purpose: z.enum(['ai', 'manual_proof']).default('ai'),
});

/** POST /api/water/upload-url → { uploadUrl, imageKey, expiresIn, maxBytes } */
waterRouter.post(
  '/upload-url',
  uploadUrlLimiter,
  validate({ body: uploadUrlSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.createUploadUrl(req.couple!, req.userId!, req.body.mimeType, req.body.sizeBytes, req.body.purpose), 201);
  }),
);

const photoSchema = z.object({ imageKey: z.string().min(1).max(300) });

/** POST /api/water/photo { imageKey } → AI estimate → PENDING log for the partner to confirm. */
waterRouter.post(
  '/photo',
  waterPhotoLimiter,
  validate({ body: photoSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.submitFromPhoto(req.couple!, req.userId!, req.body.imageKey), 201);
  }),
);

const manualSchema = z.object({
  amountMl: z.number().int().min(10).max(MAX_MANUAL_ML),
  imageKey: z.string().min(1).max(300).optional(),
});

/** POST /api/water/manual { amountMl, imageKey? } → PENDING log, never AI. */
waterRouter.post(
  '/manual',
  waterManualLimiter,
  validate({ body: manualSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.submitManual(req.couple!, req.userId!, req.body.amountMl, req.body.imageKey), 201);
  }),
);

/** POST /api/water/logs/:id/approve — partner confirms; only then the ml counts. */
waterRouter.post(
  '/logs/:id/approve',
  validate({ params: logIdParam }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.review(req.couple!, req.userId!, req.params.id, 'approve'));
  }),
);

/** POST /api/water/logs/:id/reject — partner rejects, or the submitter withdraws. */
waterRouter.post(
  '/logs/:id/reject',
  validate({ params: logIdParam }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.review(req.couple!, req.userId!, req.params.id, 'reject'));
  }),
);

/** GET /api/water/logs/:id/image-url → short-lived presigned GET. */
waterRouter.get(
  '/logs/:id/image-url',
  validate({ params: logIdParam }),
  asyncHandler(async (req, res) => {
    ok(res, await waterService.imageUrl(req.couple!, req.params.id));
  }),
);
