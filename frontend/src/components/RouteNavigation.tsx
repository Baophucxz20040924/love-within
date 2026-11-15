import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { isPrivacyLocked } from '../features/privacy/store';

/** Router-level focus and scroll, independent of query filters and modal state. */
export function RouteNavigation() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const active = useRef({ key: location.key, pathname: location.pathname });

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    const remember = () => positions.current.set(active.current.key, window.scrollY);
    window.addEventListener('scroll', remember, { passive: true });
    return () => {
      window.history.scrollRestoration = previous;
      window.removeEventListener('scroll', remember);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = active.current;
    const pathChanged = previous.pathname !== location.pathname;
    // Query-only history entries inherit the current position without resetting focus.
    if (!pathChanged) {
      positions.current.set(location.key, positions.current.get(previous.key) ?? window.scrollY);
      active.current = { key: location.key, pathname: location.pathname };
      return;
    }
    active.current = { key: location.key, pathname: location.pathname };
    const top = navigationType === 'POP' ? positions.current.get(location.key) ?? 0 : 0;
    let focused = false;
    let focusedTitle: HTMLElement | null = null;
    let restoring = true;
    const apply = () => {
      if (isPrivacyLocked()) return;
      // A lazy route can replace a header focused during the initial commit.
      if (focusedTitle && !focusedTitle.isConnected) focused = false;
      if (!focused && !document.querySelector('[aria-modal="true"]')) {
        const title = document.querySelector<HTMLElement>('main h1, .page h1');
        if (title) {
          const oldTabIndex = title.getAttribute('tabindex');
          title.tabIndex = -1;
          title.focus({ preventScroll: true });
          title.addEventListener('blur', () => {
            if (oldTabIndex === null) title.removeAttribute('tabindex');
            else title.setAttribute('tabindex', oldTabIndex);
          }, { once: true });
          focusedTitle = title;
          focused = document.activeElement === title;
        }
      }
      if (restoring) {
        window.scrollTo({ top, behavior: 'instant' });
        restoring = document.documentElement.scrollHeight - window.innerHeight < top;
      }
    };
    // Lazy pages and retained list data may arrive after the route commits.
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
    const stopRestoring = () => { restoring = false; };
    window.addEventListener('wheel', stopRestoring, { passive: true });
    window.addEventListener('touchstart', stopRestoring, { passive: true });
    window.addEventListener('keydown', stopRestoring);
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      window.removeEventListener('wheel', stopRestoring);
      window.removeEventListener('touchstart', stopRestoring);
      window.removeEventListener('keydown', stopRestoring);
    };
  }, [location.key, location.pathname, navigationType]);

  return null;
}
