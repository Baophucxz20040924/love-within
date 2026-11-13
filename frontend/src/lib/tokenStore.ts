import type { AuthTokens } from './types';

const ACCESS_KEY = 'lw.accessToken';
const REFRESH_KEY = 'lw.refreshToken';
const SESSION_KEY = 'lw.sessionGeneration';

/** Identity of a login, not of a token rotation. Persisted so other tabs also invalidate old work. */
function generation(): string {
  return localStorage.getItem(SESSION_KEY) ?? 'legacy';
}

function advance(): void {
  localStorage.setItem(SESSION_KEY, crypto.randomUUID());
}

export const tokenStore = {
  generation,
  isCurrent(expected: string): boolean {
    return generation() === expected;
  },
  get(): AuthTokens | null {
    const accessToken = localStorage.getItem(ACCESS_KEY);
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  },
  /** Start a new login. Refresh must use rotate(), never set(). */
  set(tokens: AuthTokens): void {
    advance();
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
  rotate(tokens: AuthTokens, expected: string): boolean {
    if (!this.isCurrent(expected)) return false;
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    return true;
  },
  clear(expected?: string): boolean {
    if (expected !== undefined && !this.isCurrent(expected)) return false;
    advance();
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    return true;
  },
  isSessionKey(key: string): boolean {
    return key === SESSION_KEY;
  },
  /** Legacy token removals are still followed across tabs. */
  isTokenKey(key: string): boolean {
    return key === ACCESS_KEY || key === REFRESH_KEY;
  },
};
