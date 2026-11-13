import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const requests = new AsyncLocalStorage<{ requestId: string }>();

/** Server-generated only: never trust or echo client IDs, tokens, or tracing baggage. */
export const requestCorrelation: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  requests.run({ requestId }, next);
};

export function currentRequestId(): string | undefined {
  return requests.getStore()?.requestId;
}
