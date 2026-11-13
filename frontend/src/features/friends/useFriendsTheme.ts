import { useLayoutEffect } from 'react';

const THEME_COLOR = '#f3f6fb';

// Several components may want the blue theme at the same time (the friends space and the invite landing page):
// count them, so one unmounting does not switch the theme off for the other.
let holders = 0;
let savedColor: string | undefined;

/**
 * Blue theme for the friends space: sets data-theme on <html> (so portals such as sheets and the
 * composer turn blue too) and the browser toolbar color. Layout effect: applied before paint, so a
 * reload inside the friends space never flashes the pink theme. Restored when the last user is gone.
 */
export function useFriendsTheme(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (holders === 0) {
      root.dataset.theme = 'friends';
      savedColor = meta?.content;
      if (meta) meta.content = THEME_COLOR;
    }
    holders += 1;
    return () => {
      holders -= 1;
      if (holders > 0) return;
      delete root.dataset.theme;
      if (meta && savedColor) meta.content = savedColor;
    };
  }, [enabled]);
}
