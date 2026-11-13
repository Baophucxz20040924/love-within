import type { ApiError, AuthTokens } from './types';
import { tokenStore } from './tokenStore';

const BASE = '/api';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  _retry?: boolean;
}

let refreshing: { generation: string; promise: Promise<AuthTokens | null> } | null = null;

/** Carries the generation after clearing, so a delayed event cannot log out a newer account. */
export const SESSION_EXPIRED_EVENT = 'lw:session-expired';

export function assertCurrentSession(generation: string): void {
  if (!tokenStore.isCurrent(generation)) {
    throw new ApiRequestError(409, 'SESSION_CHANGED', 'Phiên đăng nhập đã thay đổi.');
  }
}

async function refreshTokens(generation: string): Promise<AuthTokens | null> {
  assertCurrentSession(generation);
  const tokens = tokenStore.get();
  if (!tokens) return null;
  if (refreshing?.generation === generation) return refreshing.promise;
  const promise = fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!tokenStore.isCurrent(generation)) return null;
      if (res.ok) {
        const json = (await res.json()) as { data: AuthTokens };
        return tokenStore.rotate(json.data, generation) ? json.data : null;
      }
      // Temporary 429/5xx and network failures must not end a session.
      if ((res.status === 400 || res.status === 401 || res.status === 403) && tokenStore.clear(generation)) {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: tokenStore.generation() }));
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      if (refreshing?.promise === promise) refreshing = null;
    });
  refreshing = { generation, promise };
  return promise;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, _retry = false } = options;
  // Capture once, BEFORE the original request. A retry may rotate tokens, never switch logins.
  const generation = tokenStore.generation();
  const send = () => {
    assertCurrentSession(generation);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tokens = auth ? tokenStore.get() : null;
    // Cache cancellation/clearing can briefly wake mounted observers during logout.
    // Fail locally instead of dispatching tokenless private requests in that interval.
    if (auth && !tokens) throw new ApiRequestError(401, 'SESSION_REQUIRED', 'Vui lòng đăng nhập lại.');
    if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    return fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  };
  let res = await send();
  assertCurrentSession(generation);
  if (res.status === 401 && auth && !_retry) {
    const refreshed = await refreshTokens(generation);
    assertCurrentSession(generation);
    if (refreshed) {
      res = await send();
      assertCurrentSession(generation);
    }
  }
  if (!res.ok) {
    let payload: ApiError | null = null;
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      // Proxies can answer with HTML or an empty body.
    }
    assertCurrentSession(generation);
    throw new ApiRequestError(
      res.status,
      payload?.error?.code ?? 'ERROR',
      payload?.error?.message || res.statusText || 'Có lỗi xảy ra, thử lại nhé.',
      payload?.error?.details,
    );
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json()) as { data: T };
  assertCurrentSession(generation);
  return json.data;
}
