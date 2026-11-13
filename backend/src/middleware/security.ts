import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env, isProd } from '../config/env.js';
import { fail } from '../utils/response.js';

/** Mount on /api BEFORE body parsers and routes, so rejected bodies and exports are private too. */
export const apiNoStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

/** No production IP bypass: forwarded or socket loopback is never an authorization credential. */
export const requireMetricsAccess: RequestHandler = (req, res, next) => {
  if (!isProd && !env.ops.metricsToken) {
    next();
    return;
  }
  const authorization = req.headers.authorization;
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = env.ops.metricsToken;
  const valid = expected.length > 0 && supplied.length <= 512 && timingSafeEqual(
    createHash('sha256').update(supplied).digest(),
    createHash('sha256').update(expected).digest(),
  );
  if (!valid) {
    fail(res, 403, 'FORBIDDEN', 'Metrics are internal');
    return;
  }
  next();
};
