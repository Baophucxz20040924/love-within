export const ADMIN_EMAIL = 'admin@phucxz.com';

export interface AdminSession { adminToken: string; expiresAt: string }
export interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  credentialVersion: number;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}
export interface PasswordResetResult { temporaryPassword: string; expiresAt: string; credentialVersion: number }

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Separate transport: no tokenStore, refresh, React Query, logging, persistence or automatic retry. */
export async function adminRequest<T>(path: string, token: string | null, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', signal,
  });
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string } } | null = null;
    try { payload = await response.json(); } catch { /* Proxy response may not be JSON. */ }
    throw new AdminApiError(response.status, payload?.error?.code ?? 'ERROR', payload?.error?.message ?? 'Không thể hoàn tất yêu cầu.');
  }
  return ((await response.json()) as { data: T }).data;
}

export function adminErrorMessage(error: unknown): string {
  return error instanceof AdminApiError ? error.message : 'Không nhận được phản hồi từ máy chủ. Vui lòng kiểm tra kết nối.';
}
