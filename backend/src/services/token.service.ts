import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Errors } from '../utils/errors.js';
import { LIMITED_SESSION_TTL_SECONDS } from './credential.service.js';

export interface AccessPayload {
  sub: string;
  credentialVersion: number;
  /** Effective JWT expiry, bounded by both exp and the configured verification maxAge. */
  expiresAtMs: number;
}
export interface RefreshPayload { sub: string; type: 'refresh'; credentialVersion: number }
export interface LimitedPayload extends AccessPayload { type: 'admin' | 'password_change' }
type TokenType = 'access' | 'refresh' | 'admin' | 'password_change';
const ALGORITHM = 'HS256' as const;

function validatePayload(decoded: string | jwt.JwtPayload, type: TokenType): jwt.JwtPayload & { sub: string; cv: number } {
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded !== 'object' || typeof decoded.sub !== 'string' || !/^[a-f\d]{24}$/i.test(decoded.sub) ||
      typeof decoded.exp !== 'number' || !Number.isSafeInteger(decoded.exp) || decoded.exp <= now ||
      typeof decoded.iat !== 'number' || !Number.isSafeInteger(decoded.iat) || decoded.iat > now || decoded.exp <= decoded.iat) {
    throw new Error('Invalid claims');
  }
  // Only old app access tokens may lack a type; purpose-bearing grants never use that compatibility path.
  if (type === 'access' ? decoded.type !== undefined && decoded.type !== 'access' : decoded.type !== type) {
    throw new Error('Invalid token type');
  }
  if (type === 'admin' || type === 'password_change') {
    if (decoded.purpose !== type || decoded.cv === undefined) throw new Error('Invalid token purpose');
  } else if (decoded.purpose !== undefined) throw new Error('Invalid token purpose');
  const version = decoded.cv === undefined ? 0 : decoded.cv;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid credential version');
  return { ...decoded, cv: version } as jwt.JwtPayload & { sub: string; cv: number };
}

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

function claims(userId: string, credentialVersion: number, type: TokenType) {
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 0) throw new Error('Invalid credential version');
  return { sub: userId, cv: credentialVersion, type };
}

function signLimited(userId: string, version: number, type: 'admin' | 'password_change', deadlineMs?: number): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + LIMITED_SESSION_TTL_SECONDS, deadlineMs === undefined ? Infinity : Math.floor(deadlineMs / 1000));
  if (!Number.isSafeInteger(exp) || exp <= now) throw Errors.unauthorized('Quyền đăng nhập đã hết hạn');
  const token = jwt.sign({ ...claims(userId, version, type), purpose: type, iat: now, exp }, env.jwt.accessSecret, { algorithm: ALGORITHM });
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

function verifyLimited(token: string, type: 'admin' | 'password_change'): LimitedPayload {
  try {
    const decoded = validatePayload(jwt.verify(token, env.jwt.accessSecret, { algorithms: [ALGORITHM], maxAge: LIMITED_SESSION_TTL_SECONDS }), type);
    return { sub: decoded.sub, credentialVersion: decoded.cv, type, expiresAtMs: Math.min(decoded.exp!, decoded.iat! + LIMITED_SESSION_TTL_SECONDS) * 1000 };
  } catch {
    throw Errors.unauthorized('Quyền đăng nhập không hợp lệ hoặc đã hết hạn');
  }
}

export const tokenService = {
  signAccess(userId: string, credentialVersion: number): string {
    return jwt.sign(claims(userId, credentialVersion, 'access'), env.jwt.accessSecret, {
      algorithm: ALGORITHM, expiresIn: env.jwt.accessTtl as SignOptions['expiresIn'],
    });
  },
  signRefresh(userId: string, credentialVersion: number): string {
    return jwt.sign(claims(userId, credentialVersion, 'refresh'), env.jwt.refreshSecret, {
      algorithm: ALGORITHM, expiresIn: env.jwt.refreshTtl as SignOptions['expiresIn'],
    });
  },
  signAdmin(userId: string, version: number) { return signLimited(userId, version, 'admin'); },
  signPasswordChange(userId: string, version: number, temporaryExpiresAtMs: number) {
    return signLimited(userId, version, 'password_change', temporaryExpiresAtMs);
  },
  verifyAdmin(token: string): LimitedPayload { return verifyLimited(token, 'admin'); },
  verifyPasswordChange(token: string): LimitedPayload { return verifyLimited(token, 'password_change'); },
  verifyAccess(token: string): AccessPayload {
    try {
      const decoded = validatePayload(jwt.verify(token, env.jwt.accessSecret, { algorithms: [ALGORITHM], maxAge: env.jwt.accessTtl }), 'access');
      return { sub: decoded.sub, credentialVersion: decoded.cv, expiresAtMs: Math.min(decoded.exp!, decoded.iat! + maxAgeSeconds()) * 1000 };
    } catch {
      throw Errors.unauthorized('Invalid or expired access token');
    }
  },
  verifyRefresh(token: string): RefreshPayload {
    try {
      const decoded = validatePayload(jwt.verify(token, env.jwt.refreshSecret, { algorithms: [ALGORITHM] }), 'refresh');
      return { sub: decoded.sub, type: 'refresh', credentialVersion: decoded.cv };
    } catch {
      throw Errors.unauthorized('Invalid or expired refresh token');
    }
  },
};
