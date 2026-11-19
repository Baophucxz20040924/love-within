import { useLayoutEffect } from 'react';
import { setAppTheme, subscribeAppLock } from '../appLock/store';

// Multiple mounted surfaces can request the friends palette; the lock still wins.
let holders = 0;
export function useFriendsTheme(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    holders += 1;
    setAppTheme(true);
    // Auth bootstrap can reset presentation after this layout effect; the lock still masks it.
    const unsubscribe = subscribeAppLock(() => setAppTheme(holders > 0));
    return () => { unsubscribe(); holders -= 1; setAppTheme(holders > 0); };
  }, [enabled]);
}
