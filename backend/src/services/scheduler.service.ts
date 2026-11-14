import { env } from '../config/env.js';
import { notificationSendRepository } from '../repositories/notificationSend.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Background scheduler (plan/OPERATIONS.md, N2): timed work without a queue or an outside service.
 * One 60 s loop on PM2 instance 0 (or a non-cluster process), same pattern as bankSync.service.ts. Each tick runs, one
 * after the other, every registered job whose interval has elapsed. A tick never overlaps the previous one.
 *
 * Adding a job
 *   1. Write `services/jobs/<name>.job.ts` exporting a `SchedulerJob` ({ name, everyMin, run(now) }).
 *   2. Add it to `registerAllJobs()` in `services/jobs/index.ts`.
 *   `run(now)` does the work that is due at `now` and returns how many items it handled (0 = nothing to do).
 *
 * Rules for a job
 *   - Idempotent: select work that is "due and not sent yet", so a server that was down catches up on restart, and two
 *     runs at once (a dev run next to the loop) still send once. Two ways to guard a send:
 *     a. Work bound to one record (a letter whose time has come, a moment prompt): flag the record with one conditional
 *        update, e.g. `findOneAndUpdate({ _id, readyNotifiedAt: null, …due conditions }, { $set: { readyNotifiedAt: now } })`,
 *        and deliver only when that update returned the document. See jobs/lettersReady.job.ts.
 *     b. Repeating or time-dependent work (a yearly event, a meetup whose time can change): `claimSend(key)` below, with
 *        the occurrence in the key (`cp-event:<id>:2027-02-14:d1`). Deliver only when it returns true.
 *   - Bounded: read in pages with a limit and an index; drop work that is past its window (a reminder after the start).
 *   - Private text (letters, titles, notes) is never logged. The loop logs a job only when it did work (name, count, ms);
 *     a job slower than 5 s is a WARN; an error in one job is logged and counted, and the other jobs still run.
 *
 * Tests: `POST /api/dev-scheduler/run { job?, now? }` (dev only, routes/devScheduler.routes.ts) runs jobs at once with an
 * optional clock override; start the dev server with SCHEDULER_ENABLED=false so the loop does not run them as well.
 */

export interface SchedulerJob {
  /** Unique, e.g. 'letters.ready'. Shown in logs and /api/metrics. */
  name: string;
  /** Minimum minutes between two runs (the loop ticks every minute). */
  everyMin: number;
  /** Do the work due at `now`; return the number of items handled. */
  run(now: Date): Promise<number>;
}

export interface JobRunResult {
  job: string;
  count: number;
  ms: number;
  /** Set when the job threw. */
  error?: string;
}

const TICK_MS = 60_000;
/** First tick shortly after boot: catch up on what came due while the server was down. */
const FIRST_TICK_MS = 15_000;
const SLOW_JOB_MS = 5_000;
/** Timer jitter: a one-minute job seen again after 59.9 s is still due. */
const DUE_SLACK_MS = 5_000;
/** Shutdown waits at most this long for a running tick. */
const STOP_WAIT_MS = 10_000;

interface JobState {
  job: SchedulerJob;
  /** Loop clock of the last scheduled run (dev runs do not move it). */
  lastRunAt: number | null;
  runs: number;
  errors: number;
  lastMs: number | null;
  lastCount: number | null;
  lastFinishedAt: Date | null;
}

const jobs = new Map<string, JobState>();
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
/** The running tick, if any: the overlap guard and what shutdown waits for. */
let running: Promise<JobRunResult[]> | null = null;

/** Register a job once (same object again: no-op; another job with the same name: error). */
export function registerJob(job: SchedulerJob): void {
  const existing = jobs.get(job.name);
  if (existing) {
    if (existing.job === job) return;
    throw new Error(`Scheduler job "${job.name}" is already registered`);
  }
  if (!Number.isInteger(job.everyMin) || job.everyMin < 1) throw new Error(`Scheduler job "${job.name}": everyMin must be a whole number ≥ 1`);
  jobs.set(job.name, { job, lastRunAt: null, runs: 0, errors: 0, lastMs: null, lastCount: null, lastFinishedAt: null });
}

export function registeredJobNames(): string[] {
  return [...jobs.keys()];
}

/**
 * "Send once" guard for repeating or time-dependent work: inserts `key` into `notificationsends` (unique, TTL 120 days).
 * True for the first caller; false when the key was claimed already (another run, or before a restart). Throws on other
 * database errors, so the job counts an error instead of sending blindly.
 */
export function claimSend(key: string): Promise<boolean> {
  return notificationSendRepository.claim(key);
}

/** Which of these keys were claimed already: one read before the claims, so a due-all-day reminder costs no failed insert per run. */
export function alreadySent(keys: string[]): Promise<Set<string>> {
  return notificationSendRepository.existing(keys);
}

/** Run one job with error isolation, timing and counters. Never throws. */
async function runOne(state: JobState, now: Date): Promise<JobRunResult> {
  const name = state.job.name;
  const started = Date.now();
  state.runs += 1;
  try {
    const count = await state.job.run(now);
    const ms = Date.now() - started;
    state.lastMs = ms;
    state.lastCount = count;
    state.lastFinishedAt = new Date();
    if (ms > SLOW_JOB_MS) logger.warn('Scheduler job slow', { job: name, count, ms });
    else if (count > 0) logger.info('Scheduler job done', { job: name, count, ms });
    return { job: name, count, ms };
  } catch (err) {
    const ms = Date.now() - started;
    state.errors += 1;
    state.lastMs = ms;
    state.lastCount = 0;
    state.lastFinishedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Scheduler job failed', { job: name, ms, message });
    return { job: name, count: 0, ms, error: message };
  }
}

function isDue(state: JobState, nowMs: number): boolean {
  return state.lastRunAt === null || nowMs - state.lastRunAt >= state.job.everyMin * 60_000 - DUE_SLACK_MS;
}

/**
 * One loop tick: every job whose interval has elapsed at `now`, one after the other. Returns null (and does nothing)
 * while the previous tick is still running.
 */
export async function runDueJobs(now = new Date()): Promise<JobRunResult[] | null> {
  if (running) return null;
  running = (async () => {
    const results: JobRunResult[] = [];
    for (const state of jobs.values()) {
      if (!isDue(state, now.getTime())) continue;
      state.lastRunAt = now.getTime();
      results.push(await runOne(state, now));
    }
    return results;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/**
 * Dev endpoint and tests: run one job (or every job) now, whatever its interval, with an optional clock override.
 * Not held back by the loop's overlap guard, so a test can run a job twice at once to check that it sends once.
 * Does not move the loop's schedule.
 */
export async function runJobsNow(opts: { job?: string; now?: Date } = {}): Promise<JobRunResult[]> {
  const now = opts.now ?? new Date();
  const name = opts.job;
  let states: JobState[];
  if (name) {
    const state = jobs.get(name);
    if (!state) throw Errors.badRequest(`Không có job "${name}"`, { jobs: registeredJobNames() });
    states = [state];
  } else {
    states = [...jobs.values()];
  }
  const results: JobRunResult[] = [];
  for (const state of states) results.push(await runOne(state, now));
  return results;
}

/** For /api/metrics: whether the loop runs here, and per-job counters. */
export function schedulerStats() {
  return {
    enabled: env.scheduler.enabled,
    /** The loop runs in this process (enabled, instance 0, started). */
    active: timer !== null || firstTimer !== null,
    tickSec: TICK_MS / 1000,
    jobs: Object.fromEntries(
      [...jobs.values()].map((s) => [
        s.job.name,
        {
          everyMin: s.job.everyMin,
          runs: s.runs,
          errors: s.errors,
          lastMs: s.lastMs,
          lastCount: s.lastCount,
          lastFinishedAt: s.lastFinishedAt ? s.lastFinishedAt.toISOString() : null,
        },
      ]),
    ),
  };
}

/** Start the loop. Only PM2 instance 0 (or a non-cluster process) runs jobs; SCHEDULER_ENABLED=false turns it off. */
export function startScheduler(): void {
  if (!env.scheduler.enabled) {
    logger.warn('Scheduler disabled (SCHEDULER_ENABLED=false): no timed jobs in this process');
    return;
  }
  const instance = process.env.NODE_APP_INSTANCE;
  if (instance !== undefined && instance !== '0') {
    logger.info('Scheduler disabled on this instance', { instance });
    return;
  }
  if (timer || firstTimer) return;
  // First tick shortly after boot (catch up), then every minute from there.
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runDueJobs();
    timer = setInterval(() => void runDueJobs(), TICK_MS);
  }, FIRST_TICK_MS);
  logger.info('Scheduler started', { tickSec: TICK_MS / 1000, jobs: registeredJobNames() });
}

/** Stop the loop and wait (at most 10 s) for a running tick, so shutdown does not cut a job off mid-way. */
export async function stopScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
  const current = running;
  if (!current) return;
  let wait: NodeJS.Timeout | undefined;
  await Promise.race([
    current.then(() => undefined),
    new Promise<void>((resolve) => {
      wait = setTimeout(resolve, STOP_WAIT_MS);
    }),
  ]);
  if (wait) clearTimeout(wait);
}
