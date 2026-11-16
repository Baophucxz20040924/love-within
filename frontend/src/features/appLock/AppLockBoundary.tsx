import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthBackdrop } from '../auth/AuthBackdrop';
import { Icon } from '../../components/Icon';
import { ErrorState, Loading } from '../../components/StatusViews';
import { PinEntry } from './PinEntry';
import { homeOf } from '../../lib/spaceStore';
import { tokenStore } from '../../lib/tokenStore';
import { appLockEpoch, appLockState, appLockSurfaceReady, appLockVersion, finishAppUnlock, refreshLockSettings, subscribeAppLock, unlockApp } from './store';

export function useAppLock() {
  useSyncExternalStore(subscribeAppLock, appLockVersion);
  return appLockState();
}
export function AppLockCover() {
  const state = useAppLock();
  const { logout, switchSpace } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const epoch = appLockEpoch();
  useEffect(() => { setConfirmLogout(false); }, [epoch]);
  useLayoutEffect(() => {
    if ((state.phase === 'locked' || state.phase === 'error') && state.discard && location.pathname !== '/login') navigate('/login', { replace: true, state: null });
    appLockSurfaceReady();
  }, [state.version, state.discard, state.phase, location, navigate]);
  async function submit(pin: string) {
    const expected = appLockEpoch(), generation = tokenStore.generation();
    const target = await unlockApp(pin);
    if (!target || expected !== appLockEpoch() || !tokenStore.isCurrent(generation) || document.visibilityState !== 'visible') return;
    switchSpace(target);
    navigate(homeOf(target), { replace: true, state: null });
  }
  const host = document.getElementById('app-lock-entry');
  if (state.phase === 'ready' || !host) return null;
  return createPortal(<main className="auth auth--entry app-lock-cover">
    <AuthBackdrop friends={false} />
    <div className="auth__brand"><span className="brand-mark" aria-hidden="true"><Icon name="heart" size={36} strokeWidth={0} /></span><h1 className="auth__title">Love Within</h1></div>
    <div className="card stack" style={{ padding: 24, gap: 16 }}>
      {state.phase === 'locked' ? <PinEntry key={`${epoch}:${tokenStore.generation()}`} onComplete={submit} /> : state.phase === 'error' ? <ErrorState title="Chưa kết nối được" message="Hãy kết nối mạng để kiểm tra mã khóa ứng dụng." onRetry={() => void refreshLockSettings(false)} /> : <div role="status"><Loading /><p className="center text-muted">Đang kiểm tra phiên…</p></div>}
      {confirmLogout ? <div className="stack"><p>Đăng xuất trên thiết bị này và đăng nhập lại bằng email, mật khẩu? Mã khóa đã đặt vẫn được giữ.</p><button className="btn btn-primary" onClick={() => { logout(); navigate('/login', { replace: true, state: null }); }}>Đăng xuất và đăng nhập lại</button><button className="btn btn-ghost" onClick={() => setConfirmLogout(false)}>Hủy</button></div> : <button className="btn btn-ghost" onClick={() => setConfirmLogout(true)}>Đăng nhập lại</button>}
    </div>
  </main>, host);
}

/** Retain drafts behind the mask during short re-entry checks; discard them when a PIN is required. */
export function AppLockBoundary({ children }: { children: ReactNode }) {
  const state = useAppLock();
  const { bootstrapError, retryBootstrap, space } = useAuth();
  const location = useLocation();
  useLayoutEffect(() => {
    if (state.phase === 'opening' && location.pathname === homeOf(space)) finishAppUnlock();
  }, [state.phase, location.pathname, space]);
  if (state.discard) return null;
  if (bootstrapError) return <main className="app-content"><ErrorState title="Chưa kiểm tra được phiên đăng nhập" message="Phiên của bạn vẫn được giữ. Thử tải lại nhé." onRetry={retryBootstrap} /></main>;
  return <>{children}</>;
}
