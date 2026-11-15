import { useLayoutEffect } from 'react';
import { setPrivacyTheme } from '../privacy/store';

// Shared by the session layout and invite landing page; privacy always takes precedence.
let holders = 0;
export function useFriendsTheme(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    holders += 1;
    setPrivacyTheme(true);
    return () => { holders -= 1; setPrivacyTheme(holders > 0); };
  }, [enabled]);
}
