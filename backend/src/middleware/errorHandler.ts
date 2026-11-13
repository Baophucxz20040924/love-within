import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { fail } from '../utils/response.js';
import { logger } from '../utils/logger.js';

/** Wrap an async route handler so rejected promises reach the error handler. */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** 404 for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  fail(res, 404, 'NOT_FOUND', 'Route not found');
}

function routeTemplate(req: Request): string {
  return typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
}

/** Central error handler producing the standard error envelope. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (err instanceof ZodError) {
    // Surface the first field-specific message (e.g. "Email không hợp lệ")
    // so the client shows something meaningful instead of a generic string.
    const firstMessage = err.issues[0]?.message ?? 'Dữ liệu không hợp lệ';
    fail(res, 400, 'VALIDATION_ERROR', firstMessage, err.flatten());
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error('Application error', { code: err.code, status: err.status, method: req.method, routeTemplate: routeTemplate(req) });
    }
    fail(res, err.status, err.code, err.message, err.details);
    return;
  }

  // body-parser errors (malformed JSON, body too large) are client errors, not server failures.
  const status = (err as { status?: unknown; expose?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && (err as { expose?: unknown }).expose === true) {
    if (status === 413) fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu gửi lên quá lớn');
    else fail(res, status, 'BAD_REQUEST', 'Dữ liệu không hợp lệ');
    return;
  }

  logger.error('Unhandled error', { method: req.method, routeTemplate: routeTemplate(req) });
  fail(res, 500, 'INTERNAL', 'Internal server error');
}
