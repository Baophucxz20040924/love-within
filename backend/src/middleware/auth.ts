import type { NextFunction, Request, Response } from 'express';
import { tokenService } from '../services/token.service.js';
import { Errors } from '../utils/errors.js';

/** Require a valid JWT access token; attaches req.userId. Responds 401 otherwise. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw Errors.unauthorized('Thiếu access token');
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = tokenService.verifyAccess(token);
  req.userId = payload.sub;
  next();
}
