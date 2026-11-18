import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError, currentAccessEpoch } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { appLockEpoch, isAppLocked } from '../appLock/store';
import { getVerificationStatus, getVerifiedIdentity } from '../realtime/verification';
import { recordPushEnabled } from './onboardingPolicy';
import { PUSH_CONFIG_KEY, pushApi } from './api';
import {
  PushSetupError,
  deviceVersion,
  disableOnThisDevice,
  enableOnThisDevice,
  notifyDeviceChanged,
  readDeviceState,
  subscribeDevice,
  type DeviceState,
  type PushSetupErrorCode,
} from './device';

export interface PushDevice {
  /** 'loading' until the browser answered. */
  state: DeviceState | 'loading';
  /** The server has VAPID keys (null while loading or when the config could not be read). */
  serverEnabled: boolean | null;
}

/** Account-wide device state, shared by both spaces; re-read when the device changes or the tab comes back. */
export function usePushDevice(): PushDevice {
  const { me } = useAuth();
  const userId = me?.user.id ?? '';
  const generation = tokenStore.generation();
  const version = useSyncExternalStore(subscribeDevice, deviceVersion);
  const [result, setResult] = useState<{ userId: string; generation: string; version: number; state: DeviceState } | null>(null);
  const config = useQuery({ queryKey: PUSH_CONFIG_KEY, queryFn: pushApi.config, staleTime: 5 * 60_000, enabled: Boolean(userId) });

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    const publish = (state: DeviceState) => {
      if (alive && tokenStore.isCurrent(generation)) setResult({ userId, generation, version, state });
    };
    void readDeviceState(userId).then(publish, () => publish('unsupported'));
    return () => { alive = false; };
  }, [userId, generation, version]);

  // The permission can be changed in the browser's settings while the app is in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') notifyDeviceChanged();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const state = userId && result?.userId === userId && result.generation === generation && result.version === version ? result.state : 'loading';
  return { state, serverEnabled: config.data ? config.data.enabled : null };
}

const errorText = (err: unknown) =>
  err instanceof PushSetupError || err instanceof ApiRequestError ? err.message : 'Không bật được thông báo trên máy này. Thử lại sau nhé.';
const isStale = (err: unknown) => err instanceof ApiRequestError &&
  ['SESSION_CHANGED', 'PUSH_CHANGED', 'ACCESS_CHANGED'].includes(err.code);

export interface PushSwitchOptions {
  /** Onboarding renders the error inline instead of creating global toasts. */
  silent?: boolean;
  onFailure?: (code: PushSetupErrorCode) => void;
  /** Additional caller lifetime/eligibility fence, checked in the original tap and after every wait. */
  guard?: () => void;
}

/** Account-device switch. Permission remains in the tap stack; stale completions are silent. */
export function usePushSwitch(options: PushSwitchOptions = {}) {
  const { me } = useAuth();
  const userId = me?.user.id ?? '';
  const generation = tokenStore.generation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailure, setLastFailure] = useState<'dismissed' | 'denied' | 'failed' | null>(null);
  const mounted = useRef(false);
  const operation = useRef<object | null>(null);
  const identity = useRef({ userId, generation });
  identity.current = { userId, generation };

  useEffect(() => {
    mounted.current = true;
    operation.current = null;
    setBusy(false); setError(null); setLastFailure(null);
    return () => { mounted.current = false; operation.current = null; };
  }, [userId, generation]);

  function begin() {
    if (!userId || operation.current || !mounted.current) return null;
    const id = {};
    const lockEpoch = appLockEpoch(), accessEpoch = currentAccessEpoch();
    const verified = getVerifiedIdentity();
    let invalidated = false;
    const guard = () => {
      const now = getVerifiedIdentity();
      if (invalidated || !mounted.current || operation.current !== id || identity.current.userId !== userId ||
        identity.current.generation !== generation || !tokenStore.isCurrent(generation) || !tokenStore.get() ||
        lockEpoch !== appLockEpoch() || accessEpoch !== currentAccessEpoch() || isAppLocked() ||
        document.visibilityState !== 'visible' || getVerificationStatus() !== 'clear' ||
        !verified || verified.userId !== userId || verified.generation !== generation ||
        now !== verified) {
        invalidated = true;
        throw new ApiRequestError(409, 'PUSH_CHANGED', 'Cài đặt thông báo đã thay đổi.');
      }
      try { options.guard?.(); } catch (err) { invalidated = true; throw err; }
    };
    operation.current = id; // Synchronous latch: a second tap cannot race React's next render.
    try { guard(); } catch { operation.current = null; return null; }
    setBusy(true); setError(null); setLastFailure(null);
    const finish = () => {
      if (mounted.current && operation.current === id) { operation.current = null; setBusy(false); }
    };
    const current = () => { try { guard(); return true; } catch { return false; } };
    return { guard, finish, current };
  }

  /** Must be called from a tap. Resolves true only for the still-current successful operation. */
  async function enable(): Promise<boolean> {
    const work = begin();
    if (!work) return false;
    try {
      await enableOnThisDevice(userId, work.guard);
      work.guard();
      recordPushEnabled(userId);
      if (!options.silent) toast.success('Đã bật thông báo trên máy này');
      return true;
    } catch (err) {
      if (!work.current() || isStale(err)) return false;
      const code = err instanceof PushSetupError ? err.code : 'failed';
      setError(errorText(err));
      setLastFailure(code === 'denied' || code === 'dismissed' ? code : 'failed');
      if (!options.silent) {
        if (code === 'dismissed') toast.info(errorText(err));
        else toast.error(errorText(err));
      }
      options.onFailure?.(code);
      return false;
    } finally { work.finish(); }
  }

  async function disable(): Promise<void> {
    const work = begin();
    if (!work) return;
    try {
      // Explicit user action is recorded by the device layer, never by logout/background cleanup.
      await disableOnThisDevice(userId);
      if (work.current() && !options.silent) toast.info('Đã tắt thông báo trên máy này');
    } catch (err) {
      if (work.current() && !isStale(err) && !options.silent) toast.info('Đã tắt thông báo trên máy này');
    } finally { work.finish(); }
  }

  return { busy, enable, disable, error, lastFailure };
}
