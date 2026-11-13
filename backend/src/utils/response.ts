import type { Response } from 'express';

/** Send a successful JSON payload. */
export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data });
}

/** Send a standardized error envelope: { error: { code, message, details? } }. */
export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: { error: { code: string; message: string; requestId?: string; details?: unknown } } = {
    error: { code, message, ...(typeof res.locals.requestId === 'string' ? { requestId: res.locals.requestId } : {}) },
  };
  if (details !== undefined) {
    body.error.details = details;
  }
  return res.status(status).json(body);
}
