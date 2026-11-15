import type { AuthTokens } from './types';

const ACCESS_KEY = 'lw.accessToken';
const REFRESH_KEY = 'lw.refreshToken';
const SESSION_KEY = 'lw.sessionGeneration';
interface SessionRecord { id: string; tokens: AuthTokens | null }

function record(): SessionRecord | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw?.startsWith('{')) return null;
  try {
    const value = JSON.parse(raw) as SessionRecord;
    if (typeof value.id !== 'string') return { id: raw, tokens: null };
    const tokens = value.tokens;
    return { id: value.id, tokens: tokens && typeof tokens.accessToken === 'string' && typeof tokens.refreshToken === 'string'
      && tokens.accessToken && tokens.refreshToken ? tokens : null };
  } catch { return { id: raw, tokens: null }; }
}

/** Identity of a login, not of a token rotation. */
function generation(): string {
  return record()?.id ?? localStorage.getItem(SESSION_KEY) ?? 'legacy';
}

function save(session: SessionRecord): void {
  // Publish identity and both credentials atomically: another tab must never pair a new identity with old tokens.
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  // Compatibility with already-open older clients. New clients read only the atomic record.
  if (session.tokens) {
    localStorage.setItem(ACCESS_KEY, session.tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, session.tokens.refreshToken);
  } else {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }
}

export const tokenStore = {
  generation,
  isCurrent(expected: string): boolean { return generation() === expected; },
  get(): AuthTokens | null {
    const session = record();
    if (session) return session.tokens;
    const accessToken = localStorage.getItem(ACCESS_KEY);
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    return accessToken && refreshToken ? { accessToken, refreshToken } : null;
  },
  /** Start a new login. Refresh must use rotate(), never set(). */
  set(tokens: AuthTokens): void { save({ id: crypto.randomUUID(), tokens }); },
  rotate(tokens: AuthTokens, expected: string): boolean {
    if (!this.isCurrent(expected)) return false;
    save({ id: expected, tokens });
    return true;
  },
  clear(expected?: string): boolean {
    if (expected !== undefined && !this.isCurrent(expected)) return false;
    save({ id: crypto.randomUUID(), tokens: null });
    return true;
  },
  isSessionKey(key: string): boolean { return key === SESSION_KEY; },
  /** Legacy token changes are still observed across tabs. */
  isTokenKey(key: string): boolean { return key === ACCESS_KEY || key === REFRESH_KEY; },
};
