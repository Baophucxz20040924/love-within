import { Router } from 'express';
import { dbState } from '../db/connection.js';
import { schedulerStats } from '../services/scheduler.service.js';
import { snapshot } from '../utils/monitor.js';
import { requestMetricsSnapshot } from '../middleware/requestMetrics.js';
import { ok } from '../utils/response.js';
import { apiNoStore, requireMetricsAccess } from '../middleware/security.js';

export const healthRouter = Router();

/** GET /api/health — public liveness/readiness summary. */
healthRouter.get('/health', (_req, res) => {
  const s = snapshot();
  const healthy = s.db.state === 'connected';
  ok(
    res,
    {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: s.uptimeSeconds,
      memory: { rssMb: s.memory.rssMb, heapUsedMb: s.memory.heapUsedMb },
      db: dbState(),
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
});

/**
 * GET /api/metrics — detailed internal metrics. Not meant to be public:
 * Production is denied by default; opt in with OPS_METRICS_TOKEN and Authorization: Bearer <token>.
 * Forwarded IPs and loopback sockets never authorize production access. Also restrict at the proxy.
 */
healthRouter.get('/metrics', apiNoStore, requireMetricsAccess, (_req, res) => {
  // scheduler: per-job run and error counters (N2).
  ok(res, { ...snapshot(), http: requestMetricsSnapshot(), scheduler: schedulerStats() });
});
