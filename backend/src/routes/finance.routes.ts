import { Router } from 'express';
import { expensiveReadLimiter, savingsWriteLimiter } from '../middleware/rateLimit.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCouple } from '../middleware/coupleContext.js';
import { validate } from '../middleware/validate.js';
import { bankConnectLimiter, bankSyncLimiter, assistantChatLimiter, assistantInsightsLimiter } from '../middleware/rateLimit.js';
import { MAX_TXN_NOTE, TXN_DIRECTIONS } from '../models/BankTransaction.js';
import { MAX_ASSISTANT_QUESTION } from '../models/AssistantThread.js';
import { FINANCE_VISIBILITIES } from '../models/User.js';
import { financeService, type ListQuery } from '../services/finance.service.js';
import { assistantService } from '../services/assistant.service.js';
import { ok } from '../utils/response.js';
import { savingsService } from '../services/savings.service.js';

/**
 * Personal cash flow from a linked bank account (plan/CASHFLOW_PLAN.md).
 * Own data needs only auth; partner data also needs the couple context.
 */
export const financeRouter = Router();
financeRouter.use(requireAuth);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng phải có dạng YYYY-MM');

const listQuery = z.object({
  month: month.optional(),
  direction: z.enum(TXN_DIRECTIONS).optional(),
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const summaryQuery = z.object({ month: month.optional() });

const connectSchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/, 'Token không hợp lệ'),
  accountLast4: z.string().trim().regex(/^\d{4}$/, 'Nhập đúng 4 số cuối số tài khoản'),
});
const disconnectQuery = z.object({ purge: z.enum(['true', 'false']).default('false') });
const settingsSchema = z.object({ visibility: z.enum(FINANCE_VISIBILITIES) });
const noteSchema = z.object({ note: z.string().trim().max(MAX_TXN_NOTE, `Ghi chú tối đa ${MAX_TXN_NOTE} ký tự`) });
const idParam = z.object({ id: objectId });
const clearAssistantQuery = z.object({ revoke: z.enum(['true', 'false']).default('false') });
const insightsSchema = z.object({ refresh: z.boolean().default(false) });
const chatSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Nhập câu hỏi')
    .max(MAX_ASSISTANT_QUESTION, `Câu hỏi tối đa ${MAX_ASSISTANT_QUESTION} ký tự`),
});

function listArgs(q: Record<string, unknown>): ListQuery {
  return {
    month: typeof q.month === 'string' ? q.month : undefined,
    direction: q.direction === 'in' || q.direction === 'out' ? q.direction : undefined,
    cursor: typeof q.cursor === 'string' ? q.cursor : undefined,
    limit: Number(q.limit),
  };
}
const monthArg = (q: Record<string, unknown>) => (typeof q.month === 'string' ? q.month : undefined);

// ── Connection ──

/** GET /api/finance/connection — link status + my visibility (never the token). */
financeRouter.get(
  '/connection', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await financeService.getConnection(req.userId!))),
);

/** POST /api/finance/connection { token, accountLast4 } — validate with thueapibank, import ~7 days. */
financeRouter.post(
  '/connection',
  bankConnectLimiter,
  validate({ body: connectSchema }),
  asyncHandler(async (req, res) => ok(res, await financeService.connect(req.userId!, req.body), 201)),
);

/** POST /api/finance/connection/sync — poll now (reuses a poll younger than 60 s). */
financeRouter.post(
  '/connection/sync',
  bankSyncLimiter,
  asyncHandler(async (req, res) => ok(res, await financeService.syncNow(req.userId!))),
);

/** DELETE /api/finance/connection?purge=true|false — drop the token; purge also deletes transactions. */
financeRouter.delete(
  '/connection',
  validate({ query: disconnectQuery }),
  asyncHandler(async (req, res) => ok(res, await financeService.disconnect(req.userId!, req.query.purge === 'true'))),
);

/** PATCH /api/finance/settings { visibility } — private | partner. */
financeRouter.patch(
  '/settings',
  validate({ body: settingsSchema }),
  asyncHandler(async (req, res) => ok(res, await financeService.setVisibility(req.userId!, req.body.visibility))),
);

// ── My transactions ──

financeRouter.get(
  '/transactions', expensiveReadLimiter,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => ok(res, await financeService.listMine(req.userId!, listArgs(req.query)))),
);

financeRouter.get(
  '/summary', expensiveReadLimiter,
  validate({ query: summaryQuery }),
  asyncHandler(async (req, res) => ok(res, await financeService.summaryMine(req.userId!, monthArg(req.query)))),
);

/** PATCH /api/finance/transactions/:id/note { note } — owner only ('' clears). */
financeRouter.patch(
  '/transactions/:id/note',
  validate({ params: idParam, body: noteSchema }),
  asyncHandler(async (req, res) => ok(res, await financeService.setNote(req.userId!, req.params.id, req.body.note))),
);

// Own transaction snapshot, explicitly shared into the couple; no router-wide couple requirement.
financeRouter.post('/transactions/:id/savings', requireCouple, savingsWriteLimiter,
  validate({ params: idParam, body: z.object({ goalId: objectId }) }),
  asyncHandler(async (req, res) => ok(res, await savingsService.attach(req.couple!, req.userId!, req.params.id, req.body.goalId), 201)),
);

// ── Partner's transactions (only when they chose "partner" visibility) ──

financeRouter.get(
  '/partner/transactions', expensiveReadLimiter,
  requireCouple,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => ok(res, await financeService.listPartner(req.couple!, req.userId!, listArgs(req.query)))),
);

financeRouter.get(
  '/partner/summary', expensiveReadLimiter,
  requireCouple,
  validate({ query: summaryQuery }),
  asyncHandler(async (req, res) => ok(res, await financeService.summaryPartner(req.couple!, req.userId!, monthArg(req.query)))),
);

// ── AI spending assistant (plan/FINANCE_ASSISTANT_PLAN.md): own data only, last month + this month ──

/** GET /api/finance/assistant — consent, data coverage, cached insights (+ stale), conversation. No AI call. */
financeRouter.get(
  '/assistant', expensiveReadLimiter,
  asyncHandler(async (req, res) => ok(res, await assistantService.getState(req.userId!))),
);

/** POST /api/finance/assistant/consent — agree to send own cash flow to beeknoee. */
financeRouter.post(
  '/assistant/consent',
  asyncHandler(async (req, res) => ok(res, await assistantService.consent(req.userId!))),
);

/** DELETE /api/finance/assistant?revoke=true|false — delete conversation + insights; revoke also withdraws consent. */
financeRouter.delete(
  '/assistant',
  validate({ query: clearAssistantQuery }),
  asyncHandler(async (req, res) => ok(res, await assistantService.clear(req.userId!, req.query.revoke === 'true'))),
);

/** POST /api/finance/assistant/insights { refresh? } — cached unless data changed (> 6 h) or refresh. */
financeRouter.post(
  '/assistant/insights',
  assistantInsightsLimiter,
  validate({ body: insightsSchema }),
  asyncHandler(async (req, res) => ok(res, await assistantService.insights(req.userId!, req.body.refresh))),
);

/** POST /api/finance/assistant/chat { message } — one question → one answer (not streamed). */
financeRouter.post(
  '/assistant/chat',
  assistantChatLimiter,
  validate({ body: chatSchema }),
  asyncHandler(async (req, res) => ok(res, await assistantService.chat(req.userId!, req.body.message))),
);
