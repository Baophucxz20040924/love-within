import { cloneElement, useLayoutEffect, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AuthBackdrop } from '../auth/AuthBackdrop';
import { SecretBoat } from '../auth/SecretBoat';
import { useSecretEntry } from '../auth/useSecretEntry';
import { Icon } from '../../components/Icon';
import { spaceStore } from '../../lib/spaceStore';
import { tokenStore } from '../../lib/tokenStore';
import { canEnterHidden, deferPrivateNavigation, enterHidden, guardHiddenPath, isHiddenPath, isPrivacyLocked, privacySurfaceReady, privacyVersion, subscribePrivacy, takePrivateNavigation } from './store';

export function usePrivacyLock(): boolean {
  useSyncExternalStore(subscribePrivacy, privacyVersion);
  return isPrivacyLocked();
}

/** This sibling of AuthProvider survives its bootstrap-error replacement. */
export function PrivacyCover() {
  const locked = usePrivacyLock();
  const version = privacyVersion();
  const secret = useSecretEntry(locked, () => {
    enterHidden();
  }, 'cover');
  useLayoutEffect(() => { privacySurfaceReady(); }, [locked, version]);
  const host = document.getElementById('privacy-entry');
  if (!locked || !host) return null;
  return createPortal(<main className="auth auth--entry privacy-cover">
    <AuthBackdrop friends={false} />
    <div className="auth__brand">
      <button ref={secret.markRef} className="brand-mark auth__heart" type="button" aria-label="Trái tim" onClick={secret.onHeartTap}>
        <Icon name="heart" size={36} strokeWidth={0} />
      </button>
      <h1 className="auth__title">Love Within</h1>
      <p className="auth__tagline">A couple space for you and your partner.</p>
    </div>
    <div className="auth__boat-lane">{secret.boatOpen && <SecretBoat onClose={secret.dismissBoat} onBoard={secret.boardBoat} />}</div>
    <div className="card stack" style={{ gap: 16, padding: 20 }}>
      <p className="text-muted center">Một khoảng nhỏ dành cho hai người.</p>
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={secret.revealBoat}>Đăng nhập</button>
    </div>
    <p className="text-sm text-muted center">The Love Universe. built with ❤️ by Love Within.</p>
  </main>, host);
}

/** Keep one Routes tree at its last permitted location so backgrounding never destroys a draft. */
export function PrivacyRoutes({ children }: { children: ReactElement<{ location?: ReturnType<typeof useLocation> }> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const locked = usePrivacyLock();
  const last = useRef<ReturnType<typeof useLocation> | null>(null);
  const resume = useRef<ReturnType<typeof useLocation> | null>(null);
  const wasLocked = useRef(locked);
  const blocked = locked || (isHiddenPath(location.pathname) && !canEnterHidden());
  if (blocked && !resume.current && location.pathname !== '/login') resume.current = location;
  if (!blocked && !wasLocked.current) last.current = location;
  useLayoutEffect(() => {
    if (isHiddenPath(location.pathname) && !canEnterHidden()) guardHiddenPath(location.pathname);
    if (blocked) {
      if (location.pathname !== '/login' || location.search || location.hash || location.state) navigate('/login', { replace: true, state: null });
    } else if (wasLocked.current) {
      const pending = takePrivateNavigation();
      const restore = resume.current;
      resume.current = null;
      if (pending) navigate(pending, { replace: true });
      else if (tokenStore.get() && spaceStore.get() === 'friends') navigate(restore && restore.pathname !== '/friends/login' ? restore : '/friends', { replace: true });
      else if (restore && restore.pathname.startsWith('/j/')) navigate(restore, { replace: true });
      else navigate('/friends/login', { replace: true });
    }
    wasLocked.current = blocked;
  }, [blocked, location, navigate]);
  // Late private navigations cannot replace the frozen route. Notification destinations are queued explicitly by PushSync.
  if (blocked) return last.current ? cloneElement(children, { location: last.current }) : null;
  if (wasLocked.current) return last.current ? cloneElement(children, { location: last.current }) : null;
  last.current = location;
  return cloneElement(children, { location });
}

export function queueNotification(path: string): boolean {
  if (!isPrivacyLocked() && !(isHiddenPath(path) && !canEnterHidden())) return false;
  deferPrivateNavigation(path);
  guardHiddenPath(path);
  return true;
}
