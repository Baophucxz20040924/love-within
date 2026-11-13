import { useSyncExternalStore } from 'react';
import type { PushSpace } from '../../lib/types';

/**
 * The soft "Bật thông báo?" card (N4): shown after a meaningful action (couple: first water log sent for approval;
 * friends: first friend request), never at app start, and never again once dismissed. Stored per space on this device.
 */
type SuggestState = 'shown' | 'dismissed' | null;

const keyOf = (space: PushSpace) => `lw.pushSuggest.${space}`;
const listeners = new Set<() => void>();

function read(space: PushSpace): SuggestState {
  try {
    const v = localStorage.getItem(keyOf(space));
    return v === 'shown' || v === 'dismissed' ? v : null;
  } catch {
    return null;
  }
}

function write(space: PushSpace, value: Exclude<SuggestState, null>): void {
  try {
    localStorage.setItem(keyOf(space), value);
  } catch {
    // storage disabled: the card only lasts for this page
  }
  for (const l of listeners) l();
}

export const pushSuggest = {
  /** The action happened: the card may show from now on (unless it was dismissed before). */
  trigger(space: PushSpace): void {
    if (read(space) === null) write(space, 'shown');
  },
  dismiss(space: PushSpace): void {
    write(space, 'dismissed');
  },
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith('lw.pushSuggest.')) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePushSuggest(space: PushSpace): SuggestState {
  return useSyncExternalStore(subscribe, () => read(space));
}
