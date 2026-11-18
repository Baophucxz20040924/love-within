import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAppLock } from '../appLock/AppLockBoundary';
import { getVerifiedIdentity, subscribeVerification } from '../realtime/verification';
import { tokenStore } from '../../lib/tokenStore';

/** Privacy masks retain children; mounted alone never means access has been verified. */
export function usePushReadiness(): boolean {
  const { me, loading, bootstrapError, passwordChange, space } = useAuth();
  const lock = useAppLock();
  const verified = useSyncExternalStore(subscribeVerification, getVerifiedIdentity, () => null);
  const [foreground, setForeground] = useState(() => document.visibilityState === 'visible' && navigator.onLine);
  useEffect(() => {
    const update = () => setForeground(document.visibilityState === 'visible' && navigator.onLine);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return !!me && !loading && !bootstrapError && !passwordChange && lock.phase === 'ready' && foreground
    && verified?.generation === tokenStore.generation() && verified.userId === me.user.id && verified.space === space;
}
