import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Errors } from '../utils/errors.js';

export interface AccessPayload {
  sub: string; // user id
  /** Effective JWT expiry, bounded by both exp and the configured verification maxAge. */
  expiresAtMs: number;
}

export interface RefreshPayload {
  sub: string; // user id
  type: 'refresh';
}

/** Only accept the algorithm we sign with, so a token can never pick its own verification method. */
const ALGORITHM = 'HS256' as const;

function validatePayload(decoded: string | jwt.JwtPayload, type: 'access' | 'refresh'): jwt.JwtPayload & { sub: string } {
  if (typeof decoded !== 'object' || typeof decoded.sub !== 'string' || !/^[a-f\d]{24}$/i.test(decoded.sub) ||
      typeof decoded.exp !== 'number' || !Number.isSafeInteger(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000) ||
      typeof decoded.iat !== 'number' || !Number.isSafeInteger(decoded.iat) || decoded.iat > Math.floor(Date.now() / 1000) ||
      decoded.exp <= decoded.iat) {
    throw new Error('Invalid claims');
  }
  // Previously issued access tokens had no type; verifyAccess also bounds their age to the current access TTL.
  if (type === 'refresh' ? decoded.type !== 'refresh' : decoded.type !== undefined && decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }
  return decoded as jwt.JwtPayload & { sub: string };
}

// jsonwebtoken uses the same `timespan` parser for sign expiresIn and verify maxAge.
// Derive the exact integer-second offset with that parser, avoiding a divergent TTL parser.
let accessMaxAgeSeconds: number | undefined;
function maxAgeSeconds(): number {
  if (accessMaxAgeSeconds === undefined) {
    const base = 1_000_000_000;
    const probe = jwt.sign({ iat: base }, env.jwt.accessSecret, { algorithm: ALGORITHM, expiresIn: env.jwt.accessTtl as SignOptions['expiresIn'] });
    const decoded = jwt.decode(probe) as jwt.JwtPayload;
    if (typeof decoded.exp !== 'number') throw new Error('Invalid access TTL');
    accessMaxAgeSeconds = decoded.exp - base;
  }
  return accessMaxAgeSeconds;
}

export const tokenService = {
  signAccess(userId: string): string {
    const opts: SignOptions = { algorithm: ALGORITHM, expiresIn: env.jwt.accessTtl as SignOptions['expiresIn'] };
    return jwt.sign({ sub: userId, type: 'access' }, env.jwt.accessSecret, opts);
  },

  signRefresh(userId: string): string {
    const opts: SignOptions = { algorithm: ALGORITHM, expiresIn: env.jwt.refreshTtl as SignOptions['expiresIn'] };
    return jwt.sign({ sub: userId, type: 'refresh' }, env.jwt.refreshSecret, opts);
  },

  verifyAccess(token: string): AccessPayload {
    try {
      const decoded = validatePayload(jwt.verify(token, env.jwt.accessSecret, { algorithms: [ALGORITHM], maxAge: env.jwt.accessTtl }), 'access');
      return { sub: decoded.sub, expiresAtMs: Math.min(decoded.exp!, decoded.iat! + maxAgeSeconds()) * 1000 };
    } catch {
      throw Errors.unauthorized('Invalid or expired access token');
    }
  },

  verifyRefresh(token: string): RefreshPayload {
    try {
      const decoded = validatePayload(jwt.verify(token, env.jwt.refreshSecret, { algorithms: [ALGORITHM] }), 'refresh');
      return { sub: decoded.sub, type: 'refresh' };
    } catch {
      throw Errors.unauthorized('Invalid or expired refresh token');
    }
  },
};
