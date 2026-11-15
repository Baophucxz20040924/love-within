import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthBackdrop } from '../auth/AuthBackdrop';
import { Icon } from '../../components/Icon';
import { ErrorState, Loading } from '../../components/StatusViews';
import { ApiRequestError } from '../../lib/apiClient';
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
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const submitting = useRef(false);
  const epoch = appLockEpoch();
  useEffect(() => { setPin(''); setError(''); setConfirmLogout(false); }, [epoch]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  useLayoutEffect(() => {
    if ((state.phase === 'locked' || state.phase === 'error') && state.discard && location.pathname !== '/login') navigate('/login', { replace: true, state: null });
    appLockSurfaceReady();
  }, [state.version, state.discard, state.phase, location, navigate]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !/^[0-9]{6}$/.test(pin) || retryAt > Date.now()) return;
    const expected = appLockEpoch(), generation = tokenStore.generation();
    submitting.current = true; setBusy(true); setError('');
    const value = pin; setPin('');
    try {
      const target = await unlockApp(value);
      if (!target) return;
      switchSpace(target);
      navigate(homeOf(target), { replace: true, state: null });
    } catch (err) {
      if (expected !== appLockEpoch() || !tokenStore.isCurrent(generation)) return;
      setError(err instanceof ApiRequestError ? err.message : 'Chưa kết nối được máy chủ. Thử lại nhé.');
      const details = err instanceof ApiRequestError ? err.details as { retryAfterSeconds?: number } | undefined : undefined;
      if (details?.retryAfterSeconds) { setRetryAt(Date.now() + details.retryAfterSeconds * 1000); setNow(Date.now()); }
    } finally { submitting.current = false; setBusy(false); }
  }
  const host = document.getElementById('app-lock-entry');
  if (state.phase === 'ready' || !host) return null;
  const waiting = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return createPortal(<main className="auth auth--entry app-lock-cover">
    <AuthBackdrop friends={false} />
    <div className="auth__brand"><span className="brand-mark" aria-hidden="true"><Icon name="heart" size={36} strokeWidth={0} /></span><h1 className="auth__title">Love Within</h1></div>
    <div className="card stack" style={{ padding: 24, gap: 16 }}>
      {state.phase === 'locked' ? <form className="form" onSubmit={submit}>
        <label className="field"><span className="field__label">Nhập mã mở ứng dụng</span><input className="input" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={pin} disabled={busy || waiting > 0} onChange={event => setPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} aria-describedby="app-lock-hint" /></label>
        <p id="app-lock-hint" className="text-sm text-muted">Mã gồm 6 chữ số bạn đã thiết lập.</p>
        {error && <p role="alert" className="form-error">{error}</p>}
        {waiting > 0 && <p role="status">Thử lại sau {waiting} giây.</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || waiting > 0}>{busy ? 'Đang kiểm tra…' : 'Mở ứng dụng'}</button>
      </form> : state.phase === 'error' ? <ErrorState title="Chưa kết nối được" message="Hãy kết nối mạng để kiểm tra mã khóa ứng dụng." onRetry={() => void refreshLockSettings(false)} /> : <div role="status"><Loading /><p className="center text-muted">Đang kiểm tra phiên…</p></div>}
      {confirmLogout ? <div className="stack"><p>Đăng xuất trên thiết bị này và đăng nhập lại bằng email, mật khẩu? Mã khóa đã đặt vẫn được giữ.</p><button className="btn btn-primary" onClick={() => { logout(); navigate('/login', { replace: true, state: null }); }}>Đăng xuất và đăng nhập lại</button><button className="btn btn-ghost" onClick={() => setConfirmLogout(false)}>Hủy</button></div> : <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmLogout(true)}>Đăng nhập lại</button>}
    </div>
  </main>, host);
}

/** Unmount only a protected space; a no-PIN space keeps its draft during status revalidation. */
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
