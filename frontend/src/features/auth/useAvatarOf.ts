import { useCallback } from 'react';
import { useAuth } from './AuthContext';

/**
 * Couple space: photo URL of me or my partner by user id (from /me). Couple screens only ever show these two
 * people, so stories, comments and approval cards can look the photo up here instead of the server repeating it.
 */
export function useAvatarOf(): (userId: string | null | undefined) => string | null {
  const { me } = useAuth();
  return useCallback(
    (userId) => {
      if (!userId || !me) return null;
      if (userId === me.user.id) return me.user.avatarUrl;
      return me.couple?.members.find((m) => m.id === userId)?.avatarUrl ?? null;
    },
    [me],
  );
}
