import { apiRequest } from '../../lib/apiClient';
import type { AssistantChatResult, AssistantInsightsResult, AssistantState, SpendCategory } from '../../lib/types';

export const assistantApi = {
  state: () => apiRequest<AssistantState>('/finance/assistant'),
  consent: () => apiRequest<{ consented: true; consentedAt: string }>('/finance/assistant/consent', { method: 'POST' }),
  /** Delete conversation + insights; `revoke` also withdraws consent. */
  clear: (revoke: boolean) =>
    apiRequest<{ cleared: boolean; consented: boolean }>(`/finance/assistant?revoke=${revoke}`, { method: 'DELETE' }),
  insights: (refresh: boolean) =>
    apiRequest<AssistantInsightsResult>('/finance/assistant/insights', { method: 'POST', body: { refresh } }),
  chat: (message: string) => apiRequest<AssistantChatResult>('/finance/assistant/chat', { method: 'POST', body: { message } }),
};

export const ASSISTANT_KEY = ['finance', 'assistant'] as const;
export const ASSISTANT_PATH = '/finance/assistant';
export const MAX_ASSISTANT_QUESTION = 1000;

export const SPEND_CATEGORY_LABELS: Record<SpendCategory | 'unnoted', string> = {
  food: 'Ăn uống',
  transport: 'Đi lại',
  shopping: 'Mua sắm',
  bills: 'Hóa đơn',
  fun: 'Giải trí',
  health: 'Sức khỏe',
  gift: 'Quà tặng',
  travel: 'Du lịch',
  home: 'Nhà cửa',
  other: 'Khác',
  unnoted: 'Chưa ghi chú',
};
