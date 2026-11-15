import { useLayoutEffect } from 'react';
import { setAppTheme } from '../appLock/store';

// Multiple mounted surfaces can request the friends palette; the lock still wins.
let holders = 0;
export function useFriendsTheme(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    holders += 1;
    setAppTheme(true);
    return () => { holders -= 1; setAppTheme(holders > 0); };
  }, [enabled]);
}
