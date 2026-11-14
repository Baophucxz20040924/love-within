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

// A response issued before a privacy change cannot be applied after the change.
// A rejected mutation may already have committed; callers must preserve their retry/idempotency policy.
let accessEpoch = 0;
export function currentAccessEpoch(): number { return accessEpoch; }
export function advanceAccessEpoch(): void { accessEpoch += 1; }
function assertAccessEpoch(epoch: number): void {
  if (epoch !== accessEpoch) throw new ApiRequestError(503, 'ACCESS_CHANGED', 'Quyền truy cập đã thay đổi. Kết quả có thể đã được lưu; hãy kiểm tra trước khi tiếp tục.');
}

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

/** Fetch with the same session/refresh rules as JSON requests. A caller's abort never cancels the shared refresh. */
export async function authenticatedResponse(path: string, init: RequestInit = {}, auth = true, retry = true, requestEpoch?: number): Promise<Response> {
  const generation = tokenStore.generation();
  const check = () => {
    assertCurrentSession(generation);
    if (requestEpoch !== undefined) assertAccessEpoch(requestEpoch);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const send = () => {
    check();
    const headers = new Headers(init.headers);
    const tokens = auth ? tokenStore.get() : null;
    if (auth && !tokens) throw new ApiRequestError(401, 'SESSION_REQUIRED', 'Vui lòng đăng nhập lại.');
    if (tokens) headers.set('Authorization', `Bearer ${tokens.accessToken}`);
    return fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' });
  };
  let res = await send();
  check();
  if (res.status === 401 && auth && retry) {
    const refreshed = await refreshTokens(generation);
    check();
    if (refreshed) {
      res = await send();
      check();
    }
  }
  return res;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, _retry = false } = options;
  const generation = tokenStore.generation();
  const epoch = currentAccessEpoch();
  const res = await authenticatedResponse(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, auth, !_retry, auth ? epoch : undefined);
  assertCurrentSession(generation);
  if (auth) assertAccessEpoch(epoch);
  if (!res.ok) {
    let payload: ApiError | null = null;
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      // Proxies can answer with HTML or an empty body.
    }
    assertCurrentSession(generation);
    if (auth) assertAccessEpoch(epoch);
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
  if (auth) assertAccessEpoch(epoch);
  return json.data;
}
