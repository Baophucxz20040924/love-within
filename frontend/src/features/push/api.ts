import { apiRequest, ApiRequestError, assertCurrentSession, authenticatedResponse } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import type { ApiError } from '../../lib/types';
import type { PushConfig, PushSettings, PushSettingsPatch, PushSpace } from '../../lib/types';

/** Web Push (plan/OPERATIONS.md, N4). The browser side (permission, subscription) is in ./device.ts. */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Device transport belongs to the login, not the current content-access epoch/space. */
async function deviceRequest<T>(method: string, body?: unknown, path = '/push/subscriptions'): Promise<T> {
  const generation = tokenStore.generation();
  const controller = new AbortController();
  let timer: number | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new DOMException('Timed out', 'TimeoutError'));
    }, 15_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await authenticatedResponse(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await response.json() as { data: T } & ApiError;
      assertCurrentSession(generation);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!response.ok) throw new ApiRequestError(response.status, json.error?.code ?? 'ERROR', json.error?.message ?? 'Không cập nhật được thông báo.');
      return json.data;
    })()]);
  } finally {
    window.clearTimeout(timer);
  }
}

export const pushApi = {
  config: () => deviceRequest<PushConfig>('GET', undefined, '/push/config'),
  subscribe: (body: PushSubscriptionBody) => deviceRequest<{ device: string }>('POST', body),
  unsubscribe: (endpoint: string) => deviceRequest<{ removed: boolean }>('DELETE', { endpoint }),
  settings: (space: PushSpace) => apiRequest<PushSettings>(`/push/settings?space=${space}`),
  updateSettings: (patch: PushSettingsPatch) => apiRequest<PushSettings>('/push/settings', { method: 'PATCH', body: patch }),
  test: (endpoint: string) => apiRequest<{ sent: true }>('/push/test', { method: 'POST', body: { endpoint } }),
};

export const PUSH_CONFIG_KEY = ['push', 'config'] as const;
export const pushSettingsKey = (space: PushSpace) => ['push', 'settings', space] as const;
