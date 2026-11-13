/** Standard application error carrying an HTTP status + machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message = 'Bad request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'Conflict', details?: unknown) =>
    new AppError(409, 'CONFLICT', message, details),
  unprocessable: (message = 'Unprocessable', details?: unknown) =>
    new AppError(422, 'UNPROCESSABLE', message, details),
  tooMany: (message = 'Too many requests') => new AppError(429, 'TOO_MANY_REQUESTS', message),
  internal: (message = 'Internal server error') => new AppError(500, 'INTERNAL', message),
};
