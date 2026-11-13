import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const CHECK_INTERVAL_MS = 30_000;
const LAG_WARN_MS = 200;

let histogram: IntervalHistogram | null = null;
let timer: NodeJS.Timeout | null = null;
let lastWarnAt = 0;

const counters = { requests: 0, errors5xx: 0, rateLimited: 0 };

const TIMING_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const PULSE_SECTIONS = ['question', 'letters', 'nextEvent', 'nudges', 'moods', 'moment', 'savings'] as const;
type PulseSection = typeof PULSE_SECTIONS[number];
type PulseOutcome = 'ok' | 'empty' | 'error';
type SavingsStage = 'acquire' | 'held';
type SavingsOutcome = 'ok' | 'busy' | 'not_found' | 'rejected' | 'recovery_required';
interface Timing { count: number; totalMs: number; maxMs: number; buckets: number[] }
const timings = new Map<string, Timing>();
// Fixed allowlist bounds cardinality even if a future caller supplies untrusted strings at runtime.
const timingKeys = new Set([
  ...PULSE_SECTIONS.flatMap((section) => ['ok', 'empty', 'error'].map((outcome) => `pulse.${section}.${outcome}`)),
  ...['acquire', 'held'].flatMap((stage) => ['ok', 'busy', 'not_found', 'rejected', 'recovery_required'].map((outcome) => `savings.${stage}.${outcome}`)),
]);
function recordTiming(key: string, ms: number): void {
  if (!timingKeys.has(key) || !Number.isFinite(ms) || ms < 0) return;
  let sample = timings.get(key);
  if (!sample) {
    sample = { count: 0, totalMs: 0, maxMs: 0, buckets: TIMING_BUCKETS_MS.map(() => 0) };
    timings.set(key, sample);
  }
  sample.count++;
  sample.totalMs += ms;
  sample.maxMs = Math.max(sample.maxMs, ms);
  TIMING_BUCKETS_MS.forEach((bound, i) => { if (ms <= bound) sample!.buckets[i]++; });
}
export function observePulseSection(section: PulseSection, outcome: PulseOutcome, ms: number): void {
  recordTiming(`pulse.${section}.${outcome}`, ms);
}
export function observeSavingsWrite(stage: SavingsStage, outcome: SavingsOutcome, ms: number): void {
  recordTiming(`savings.${stage}.${outcome}`, ms);
}
export function operationMetricsSnapshot() {
  return {
    bucketUpperBoundsMs: [...TIMING_BUCKETS_MS],
    maxSeries: timingKeys.size,
    savingsHeldMeasurement: 'observed ownership until release or failure; retained recovery tokens continue holding beyond this sample',
    timings: Object.fromEntries([...timings].map(([key, value]) => [key, { ...value, buckets: [...value.buckets] }])),
  };
}

export function countRequest(status: number): void {
  counters.requests += 1;
  if (status >= 500) counters.errors5xx += 1;
  if (status === 429) counters.rateLimited += 1;
}

export function snapshot() {
  const mem = process.memoryUsage();
  const lagMs = histogram ? Number((histogram.mean / 1e6).toFixed(1)) : null;
  const lagP99Ms = histogram ? Number((histogram.percentile(99) / 1e6).toFixed(1)) : null;
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      warnThresholdMb: env.ops.memWarnMb,
    },
    eventLoop: { meanLagMs: lagMs, p99LagMs: lagP99Ms, warnThresholdMs: LAG_WARN_MS },
    db: {
      state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] ?? 'unknown',
    },
    counters: { ...counters },
    operations: operationMetricsSnapshot(),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

/**
 * Lightweight periodic self-check (Requirement 13.3). Logs a WARNING when RSS exceeds
 * MEM_WARN_MB or mean event-loop lag exceeds LAG_WARN_MS. At most one warning per minute.
 * README documents what to do when these fire (upgrade VPS / split services).
 */
export function startResourceMonitor(): void {
  if (timer) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  timer = setInterval(() => {
    const s = snapshot();
    const reasons: string[] = [];
    if (s.memory.rssMb > env.ops.memWarnMb) reasons.push(`RSS ${s.memory.rssMb}MB > ${env.ops.memWarnMb}MB`);
    if (s.eventLoop.meanLagMs !== null && s.eventLoop.meanLagMs > LAG_WARN_MS) {
      reasons.push(`event-loop lag ${s.eventLoop.meanLagMs}ms > ${LAG_WARN_MS}ms`);
    }
    if (reasons.length && Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now();
      logger.warn('RESOURCE PRESSURE — consider upgrading the VPS or offloading work', {
        reasons,
        rssMb: s.memory.rssMb,
        lagMs: s.eventLoop.meanLagMs,
      });
    }
    histogram?.reset();
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopResourceMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
}
