import type { Request } from 'express';
import { tokenService } from '../services/token.service.js';
import { credentialService } from '../services/credential.service.js';
import { Errors } from '../utils/errors.js';
import { asyncHandler } from './errorHandler.js';

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized('Thiếu access token');
  return header.slice('Bearer '.length).trim();
}

/** Wrapped for Express 4: DB failures and rejected credentials always reach the central error handler. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const payload = tokenService.verifyAccess(bearer(req));
  await credentialService.assertApp(payload.sub, payload.credentialVersion);
  req.userId = payload.sub;
  req.credentialVersion = payload.credentialVersion;
  req.authKind = 'app';
  req.accessExpiresAtMs = payload.expiresAtMs;
  next();
});

export const requireAdmin = asyncHandler(async (req, _res, next) => {
  const payload = tokenService.verifyAdmin(bearer(req));
  await credentialService.assertAdmin(payload.sub, payload.credentialVersion);
  req.userId = payload.sub;
  req.credentialVersion = payload.credentialVersion;
  req.authKind = 'admin';
  req.accessExpiresAtMs = payload.expiresAtMs;
  next();
});
