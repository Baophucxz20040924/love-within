import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { eventCreateLimiter } from '../middleware/rateLimit.js';
import {
  EVENT_DATE_MAX,
  EVENT_DATE_MIN,
  EVENT_KINDS,
  EVENT_REPEATS,
  MAX_EVENT_EMOJI,
  MAX_EVENT_NOTE,
  MAX_EVENT_TITLE,
} from '../models/CoupleEvent.js';
import { eventService } from '../services/event.service.js';
import { isRealDate } from '../utils/date.js';
import { ok } from '../utils/response.js';

/** "Đếm ngược sự kiện" (plan/ENGINEERING_WORKFLOW.md, CP4). No dual approval: either member creates, edits or deletes. */
export const eventRouter = Router();
eventRouter.use(requireAuth, requireCouple);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const idParam = z.object({ id: objectId });

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD')
  .refine(isRealDate, 'Ngày không có thật')
  .refine((d) => d >= EVENT_DATE_MIN && d <= EVENT_DATE_MAX, 'Ngày phải trong khoảng năm 1900 tới 2100');

// No defaults here: the same fields serve the partial edit, where a missing field must stay unchanged.
const fields = {
  title: z.string().trim().min(1, 'Hãy đặt tên cho sự kiện').max(MAX_EVENT_TITLE, `Tên tối đa ${MAX_EVENT_TITLE} ký tự`),
  emoji: z
    .string()
    .trim()
    .min(1, 'Hãy chọn biểu tượng')
    .max(MAX_EVENT_EMOJI, 'Biểu tượng quá dài')
    .regex(/^\S+$/u, 'Biểu tượng không hợp lệ'),
  kind: z.enum(EVENT_KINDS),
  personId: objectId.nullable(),
  date: day,
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Giờ phải có dạng HH:mm')
    .nullable(),
  repeat: z.enum(EVENT_REPEATS),
  note: z.string().trim().max(MAX_EVENT_NOTE, `Ghi chú tối đa ${MAX_EVENT_NOTE} ký tự`),
  remind: z.boolean(),
};

const createSchema = z.object({
  title: fields.title,
  emoji: fields.emoji.optional(),
  kind: fields.kind,
  personId: fields.personId.optional(),
  date: fields.date,
  time: fields.time.optional(),
  repeat: fields.repeat.optional(),
  note: fields.note.optional(),
  remind: fields.remind.optional(),
});

const updateSchema = z
  .object({
    title: fields.title.optional(),
    emoji: fields.emoji.optional(),
    kind: fields.kind.optional(),
    personId: fields.personId.optional(),
    date: fields.date.optional(),
    time: fields.time.optional(),
    repeat: fields.repeat.optional(),
    note: fields.note.optional(),
    remind: fields.remind.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Không có gì để cập nhật');

/** GET /api/events → { upcoming, past }; each item has nextDate, daysLeft, startsAt and auto (milestone from the anniversary date). */
eventRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await eventService.list(req.couple!))),
);

/** POST /api/events — 30 per day per user. Birthday needs personId (a member). */
eventRouter.post(
  '/',
  eventCreateLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => ok(res, await eventService.create(req.couple!, req.userId!, req.body), 201)),
);

/** PATCH /api/events/:id — either member; any subset of the fields. Auto milestones have no id here (400). */
eventRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => ok(res, await eventService.update(req.couple!, req.userId!, req.params.id, req.body))),
);

/** DELETE /api/events/:id — either member (soft delete). */
eventRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await eventService.remove(req.couple!, req.userId!, req.params.id);
    ok(res, { ok: true });
  }),
);
