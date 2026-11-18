import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { syncThisDevice } from './device';
import { appLockState, lockForNavigation } from '../appLock/store';
import { spaceStore } from '../../lib/spaceStore';
import { usePushReadiness } from './readiness';
import { appLockEpoch, isAppLocked } from '../appLock/store';
import { currentAccessEpoch } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';

/**
 * Mounted once (App): refreshes the signed-in account's device without depending on its active space.
 * Notification taps are neutral entry only; existing auth, space and optional PIN guards own access.
 * Never asks for permission or persists a notification intent across accounts.
 */
export function PushSync() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const userId = me?.user.id;
  const ready = usePushReadiness();
  const generation = tokenStore.generation();

  useEffect(() => {
    if (!userId || !ready) return;
    let active = true;
    const access = currentAccessEpoch(), lock = appLockEpoch();
    void syncThisDevice(userId, () => {
      if (!active || !tokenStore.isCurrent(generation) || access !== currentAccessEpoch() || lock !== appLockEpoch()
        || isAppLocked() || document.visibilityState !== 'visible') throw new Error('Push access changed');
    }).catch(() => undefined);
    return () => { active = false; };
  }, [userId, ready, generation]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown } | null;
      if (data?.type !== 'lw:notification-open') return;
      // Re-enter a protected (or not-yet-known) space through its existing PIN guard.
      // A space explicitly configured without a PIN needs no additional privacy cover.
      if (appLockState().settings?.[spaceStore.get()] !== false) lockForNavigation();
      navigate('/', { replace: true });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return null;
}
