import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../../lib/apiClient';
import type { PushSpace } from '../../lib/types';
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
} from './device';

export interface PushDevice {
  /** 'loading' until the browser answered. */
  state: DeviceState | 'loading';
  /** The server has VAPID keys (null while loading or when the config could not be read). */
  serverEnabled: boolean | null;
}

/** This device's push state for the signed-in user in `space`; re-read after any switch and when the tab comes back. */
export function usePushDevice(space: PushSpace): PushDevice {
  const { me } = useAuth();
  const userId = me?.user.id ?? '';
  const version = useSyncExternalStore(subscribeDevice, deviceVersion);
  const [state, setState] = useState<DeviceState | 'loading'>('loading');
  const config = useQuery({ queryKey: PUSH_CONFIG_KEY, queryFn: pushApi.config, staleTime: 5 * 60_000, enabled: Boolean(userId) });

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    void readDeviceState(userId, space).then(
      (s) => alive && setState(s),
      () => alive && setState('unsupported'),
    );
    return () => {
      alive = false;
    };
  }, [userId, space, version]);

  // The permission can be changed in the browser's settings while the app is in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') notifyDeviceChanged();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return { state, serverEnabled: config.data ? config.data.enabled : null };
}

const errorText = (err: unknown) =>
  err instanceof PushSetupError || err instanceof ApiRequestError ? err.message : 'Không bật được thông báo trên máy này. Thử lại sau nhé.';

/** Switch this device on / off with the toasts the settings page and the suggestion card share. */
export function usePushSwitch(space: PushSpace) {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  /** Must be called from a tap (permission prompt). Resolves true when the device is on. */
  async function enable(): Promise<boolean> {
    if (!me || busy) return false;
    setBusy(true);
    try {
      await enableOnThisDevice(me.user.id, space);
      toast.success('Đã bật thông báo trên máy này');
      return true;
    } catch (err) {
      if (err instanceof PushSetupError && err.code === 'dismissed') toast.info(err.message);
      else toast.error(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await disableOnThisDevice();
      toast.info('Đã tắt thông báo trên máy này');
    } catch {
      toast.info('Đã tắt thông báo trên máy này');
    } finally {
      setBusy(false);
    }
  }

  return { busy, enable, disable };
}
