import { apiRequest } from '../../lib/apiClient';

/** The feed never contains private content, only minimal references. Unknown types are displayed generically. */
export interface CoupleNotification {
  id: string;
  type: string;
  actorId: string | null;
  entityId: string | null;
  target: CoupleNotificationTarget | null;
  read: boolean;
  createdAt: string;
}

export type CoupleNotificationTarget =
  | { kind: 'approval'; category: 'water' | 'proposal' | 'redemption'; id: string }
  | { kind: 'story' | 'question' | 'letter' | 'event' | 'nudge' | 'bucket' | 'savings'; id: string }
  | { kind: 'moment'; dayId: string; localDate?: string | null; sessionId?: string | null };

export interface CoupleNotificationPage {
  items: CoupleNotification[];
  nextCursor: string | null;
  /** Opaque snapshot of exactly the rows in this page. */
  watermark: string;
}
export interface CoupleNotificationUnread {
  notifications: number;
  notificationsSaturated: boolean;
}

export const COUPLE_NOTIFICATIONS_KEY = ['couple-notifications'] as const;
export const COUPLE_NOTIFICATION_UNREAD_KEY = ['couple-notification-unread'] as const;

export const coupleNotificationsApi = {
  list: (cursor?: string) => apiRequest<CoupleNotificationPage>(`/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  unread: () => apiRequest<CoupleNotificationUnread>('/notifications/unread'),
  seen: (watermark: string) => apiRequest<{ ok: true }>('/notifications/seen', { method: 'POST', body: { watermark } }),
  read: (id: string) => apiRequest<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  readAll: (watermarks: string[]) => apiRequest<{ ok: true }>('/notifications/read-all', { method: 'POST', body: { watermarks } }),
};
