import { Errors } from './errors.js';

export interface HistoryPosition { createdAt: Date; id: string }
const MAX_CURSOR = 1024;

/** A cursor is a position, never an authorization token. Callers still apply live ACLs. */
export function encodeHistoryCursor(scope: string, position: HistoryPosition): string {
  return Buffer.from(JSON.stringify([1, scope, 'desc', position.createdAt.toISOString(), position.id])).toString('base64url');
}

export function decodeHistoryCursor(cursor: string | undefined, scope: string): HistoryPosition | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor || cursor.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== scope || value[2] !== 'desc'
      || typeof value[3] !== 'string' || typeof value[4] !== 'string' || !/^[a-f0-9]{24}$/.test(value[4])) throw new Error();
    const position = { createdAt: new Date(value[3]), id: value[4] };
    if (!Number.isFinite(position.createdAt.getTime()) || encodeHistoryCursor(scope, position) !== cursor) throw new Error();
    return position;
  } catch { throw Errors.badRequest('Cursor không hợp lệ'); }
}
