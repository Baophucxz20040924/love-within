import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { runJobsNow } from '../services/scheduler.service.js';
import { ok } from '../utils/response.js';

/**
 * DEV ONLY: mounted at /api/dev-scheduler by app.ts when NODE_ENV !== 'production' (like /api/dev-storage), never in
 * production. Smoke tests run scheduler jobs on demand instead of waiting for the 60 s loop; start the dev server with
 * SCHEDULER_ENABLED=false so the loop does not run them too.
 */
export const devSchedulerRouter = Router();

const runSchema = z.object({
  /** One job by name (e.g. "letters.ready"); all jobs when left out. */
  job: z.string().min(1).max(60).optional(),
  /** Pretend the clock shows this instant (ISO 8601 with offset), e.g. "2026-11-10T08:05:00+07:00" = 08:05 couple time. */
  now: z.iso.datetime({ offset: true }).optional(),
});

/** POST /api/dev-scheduler/run { job?, now? } → { now, results: [{ job, count, ms, error? }] }. Ignores the job interval. */
devSchedulerRouter.post(
  '/run',
  validate({ body: runSchema }),
  asyncHandler(async (req, res) => {
    const now = req.body.now ? new Date(req.body.now) : new Date();
    ok(res, { now: now.toISOString(), results: await runJobsNow({ job: req.body.job, now }) });
  }),
);
