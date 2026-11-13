import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { marketService } from '../services/market.service.js';
import { ok } from '../utils/response.js';

export const marketRouter = Router();
marketRouter.use(requireAuth, requireCouple);

const idParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ') });

const createSchema = z.object({
  title: z.string().trim().min(1, 'Tên bắt buộc').max(80),
  description: z.string().trim().max(500).optional(),
  emoji: z.string().trim().min(1).max(8).optional(),
  priceCoin: z.number().int().min(1, 'Giá tối thiểu 1 Xu').max(1_000_000),
});
const updateSchema = createSchema.partial().refine((o) => Object.keys(o).length > 0, 'Không có gì để cập nhật');
const declineSchema = z.object({ note: z.string().trim().max(200, 'Lời nhắn tối đa 200 ký tự').optional() });

// ── Items (each member's shop) ─────────────────────────────

/** GET /api/market/items — every available item in the couple, flagged `isMine`. */
marketRouter.get('/items', asyncHandler(async (req, res) => ok(res, await marketService.list(req.coupleId!, req.userId!))));

marketRouter.post(
  '/items',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => ok(res, await marketService.create(req.coupleId!, req.userId!, req.body), 201)),
);

/** PATCH /api/market/items/:id — owner only. */
marketRouter.patch(
  '/items/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => ok(res, await marketService.update(req.coupleId!, req.userId!, req.params.id, req.body))),
);

/** DELETE /api/market/items/:id — owner only (archive). */
marketRouter.delete(
  '/items/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await marketService.archive(req.coupleId!, req.userId!, req.params.id);
    ok(res, { ok: true });
  }),
);

/** POST /api/market/items/:id/redeem — partner requests the reward; coins are held until the seller answers. */
marketRouter.post(
  '/items/:id/redeem',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await marketService.request(req.couple!, req.userId!, req.params.id), 201)),
);

// ── Redemptions ────────────────────────────────────────────

marketRouter.get('/redemptions', asyncHandler(async (req, res) => ok(res, await marketService.history(req.couple!, req.userId!))));

/** GET /api/market/redemptions/pending — open requests (feeds the approvals inbox). */
marketRouter.get('/redemptions/pending', asyncHandler(async (req, res) => ok(res, await marketService.pending(req.couple!, req.userId!))));

/** Seller agrees to do it. */
marketRouter.post(
  '/redemptions/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await marketService.accept(req.couple!, req.userId!, req.params.id))),
);

/** Seller declines (optional note) → coins refunded. */
marketRouter.post(
  '/redemptions/:id/decline',
  validate({ params: idParam, body: declineSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await marketService.decline(req.couple!, req.userId!, req.params.id, req.body.note ?? null)),
  ),
);

/** Buyer withdraws while still pending → coins refunded. */
marketRouter.post(
  '/redemptions/:id/cancel',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await marketService.cancel(req.couple!, req.userId!, req.params.id))),
);

/** Buyer confirms the reward was delivered. */
marketRouter.post(
  '/redemptions/:id/fulfill',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await marketService.fulfill(req.couple!, req.userId!, req.params.id))),
);

// ── Badge ──────────────────────────────────────────────────

marketRouter.get('/unread-count', asyncHandler(async (req, res) => ok(res, await marketService.unreadCount(req.couple!, req.userId!))));

marketRouter.post(
  '/seen',
  asyncHandler(async (req, res) => {
    await marketService.markSeen(req.userId!);
    ok(res, { ok: true });
  }),
);
