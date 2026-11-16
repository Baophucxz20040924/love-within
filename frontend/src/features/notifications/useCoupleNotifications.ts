import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { COUPLE_NOTIFICATION_UNREAD_KEY, coupleNotificationsApi } from './api';

/** This is unseen activity, not the count of unread rows or outstanding approvals. */
export function useCoupleNotificationUnread() {
  const { me } = useAuth();
  return useQuery({
    queryKey: COUPLE_NOTIFICATION_UNREAD_KEY,
    queryFn: coupleNotificationsApi.unread,
    enabled: Boolean(me?.user.coupleId),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}
