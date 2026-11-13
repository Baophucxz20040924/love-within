import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { countRequest } from '../utils/monitor.js';

const BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MAX_SERIES = 256;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const AREAS = new Set(['auth', 'friends', 'finance', 'couple', 'savings', 'proposals', 'stories', 'questions', 'events', 'letters', 'moments', 'bucket', 'water', 'market', 'push', 'nudges', 'moods', 'public', 'pairing']);
export type MetricArea = 'friends' | 'friends.stories' | 'friends.events' | 'friends.outings';
const FRIEND_AREAS = new Set<MetricArea>(['friends', 'friends.stories', 'friends.events', 'friends.outings']);
/** Capture a code-defined mount label; Express can restore baseUrl before finish fires. */
export function metricArea(area: MetricArea): RequestHandler {
  return (_req, res, next) => { res.locals.metricArea = FRIEND_AREAS.has(area) ? area : 'other'; next(); };
}

interface Sample {
  count: number; totalMs: number; maxMs: number; buckets: number[];
  declaredBytes: number; unknownLength: number;
}
const series = new Map<string, Sample>();
let inFlight = 0;
let aborted = 0;

/** Only code-defined route templates and allowlisted area names, never user URLs or IDs. */
export const requestMetrics: RequestHandler = (req, res, next) => {
  const start = performance.now();
  inFlight++;
  let finished = false;
  const finish = (abort: boolean) => {
    if (finished) return;
    finished = true;
    inFlight--;
    if (abort) { aborted++; return; }
    countRequest(res.statusCode);
    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const areaCandidate = req.baseUrl.split('/')[2] ?? '';
    const capturedArea = res.locals.metricArea as MetricArea | undefined;
    const area = capturedArea && FRIEND_AREAS.has(capturedArea) ? capturedArea : AREAS.has(areaCandidate) ? areaCandidate : 'other';
    const method = METHODS.has(req.method) ? req.method : 'OTHER';
    let key = `${method} ${area}:${route} ${Math.floor(res.statusCode / 100)}xx`;
    if (!series.has(key) && series.size >= MAX_SERIES - 1) key = 'overflow';
    let sample = series.get(key);
    if (!sample) {
      sample = { count: 0, totalMs: 0, maxMs: 0, buckets: BUCKETS_MS.map(() => 0), declaredBytes: 0, unknownLength: 0 };
      series.set(key, sample);
    }
    const ms = performance.now() - start;
    sample.count++;
    sample.totalMs += ms;
    sample.maxMs = Math.max(sample.maxMs, ms);
    BUCKETS_MS.forEach((bound, i) => { if (ms <= bound) sample!.buckets[i]++; });
    const length = res.getHeader('content-length');
    const bytes = length === undefined ? NaN : Number(length);
    if (Number.isSafeInteger(bytes) && bytes >= 0) sample.declaredBytes += bytes;
    else sample.unknownLength++;
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  next();
};

export function requestMetricsSnapshot() {
  return { inFlight, aborted, bucketUpperBoundsMs: [...BUCKETS_MS], maxSeries: MAX_SERIES,
    byteMeasurement: 'declared Content-Length, not wire/compressed bytes',
    routes: Object.fromEntries([...series].map(([key, value]) => [key, { ...value, buckets: [...value.buckets] }])) };
}
