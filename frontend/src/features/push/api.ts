import { apiRequest } from '../../lib/apiClient';
import type { PushConfig, PushSettings, PushSettingsPatch, PushSpace } from '../../lib/types';

/** Web Push (plan/OPERATIONS.md, N4). The browser side (permission, subscription) is in ./device.ts. */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  space: PushSpace;
}

export const pushApi = {
  config: () => apiRequest<PushConfig>('/push/config'),
  subscribe: (body: PushSubscriptionBody) => apiRequest<{ space: PushSpace; device: string }>('/push/subscriptions', { method: 'POST', body }),
  unsubscribe: (endpoint: string) => apiRequest<{ removed: boolean }>('/push/subscriptions', { method: 'DELETE', body: { endpoint } }),
  settings: (space: PushSpace) => apiRequest<PushSettings>(`/push/settings?space=${space}`),
  updateSettings: (patch: PushSettingsPatch) => apiRequest<PushSettings>('/push/settings', { method: 'PATCH', body: patch }),
  test: (endpoint: string) => apiRequest<{ sent: true }>('/push/test', { method: 'POST', body: { endpoint } }),
};

export const PUSH_CONFIG_KEY = ['push', 'config'] as const;
export const pushSettingsKey = (space: PushSpace) => ['push', 'settings', space] as const;
