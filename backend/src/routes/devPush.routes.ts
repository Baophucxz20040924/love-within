import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import type { MockPushAdapter } from '../integrations/push/MockPushAdapter.js';
import { pushService } from '../services/push.service.js';
import { ok } from '../utils/response.js';

/**
 * DEV ONLY: mounted at /api/dev-push by app.ts when PUSH_PROVIDER=mock (refused in production) and NODE_ENV is not
 * production, like /api/dev-storage. No login. Smoke tests read what would have been pushed.
 *   GET    /api/dev-push?endpoint=   → { pending, sends: [{ at, endpoint, payload, bytes, ttlSec, urgency, result, statusCode }] }
 *   DELETE /api/dev-push             → clear sends and simulated failures
 *   POST   /api/dev-push/fail { endpoint, statusCode, times? } → the next sends to that endpoint fail (410/404 = gone)
 * `pending` counts pushes still being delivered in the background: wait for 0 before checking.
 */
export function devPushRouter(mock: MockPushAdapter): Router {
  const r = Router();
  const listQuery = z.object({ endpoint: z.string().max(1000).optional() });
  const failSchema = z.object({
    endpoint: z.string().min(1).max(1000),
    statusCode: z.number().int().min(400).max(599),
    times: z.number().int().min(1).max(100).default(1),
  });

  r.get('/', validate({ query: listQuery }), (req, res) => {
    const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : undefined;
    ok(res, { pending: pushService.pendingCount(), sends: mock.list(endpoint) });
  });
  r.delete('/', (_req, res) => {
    mock.clear();
    ok(res, { ok: true });
  });
  r.post('/fail', validate({ body: failSchema }), (req, res) => {
    mock.failNext(req.body.endpoint, req.body.statusCode, req.body.times);
    ok(res, { ok: true });
  });
  return r;
}
