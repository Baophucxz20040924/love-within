import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { isAppPath, syncThisDevice } from './device';
import { isAppLocked } from '../appLock/store';

/**
 * Mounted once (App): on app start re-sends this device's subscription when it belongs to the signed-in user and the
 * session's space (drops it otherwise), and follows notification taps (the service worker posts `lw:navigate`).
 * Never asks for permission.
 */
export function PushSync() {
  const { me, space } = useAuth();
  const navigate = useNavigate();
  const userId = me?.user.id;

  useEffect(() => {
    if (!userId) return;
    void syncThisDevice(userId, space).catch(() => undefined);
  }, [userId, space]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === 'lw:navigate' && isAppPath(data.url) && !isAppLocked()) navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return null;
}
