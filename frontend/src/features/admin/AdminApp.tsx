import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AdminApiError, adminRequest, type AdminSession } from './api';
import { AdminLoginPage, AdminPasswordPage, AdminUsersPage } from './AdminPages';
import './admin.css';

export type AdminRequest = <T>(path: string, body?: unknown) => Promise<T>;

/** All credentials die with this shell. Personal tokens may stay on disk but are never read here. */
export function AdminApp() {
  const location = useLocation();
  const session = useRef<AdminSession | null>(null);
  const generation = useRef(0);
  const acceptedLogin = useRef<{ result: unknown; generation: number } | null>(null);
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const [revision, setRevision] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const end = useCallback(() => {
    generation.current += 1;
    session.current = null;
    acceptedLogin.current = null;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setExpiresAt(null);
    setRevision(value => value + 1);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    // The neutral bootstrap shield still protects tab previews; no personal lock is mounted.
    window.__lwAppLock.protected = true;
    delete document.documentElement.dataset.theme;
    document.title = 'Quản trị · Love Within';
    document.documentElement.removeAttribute('data-app-shield');
    const conceal = () => end();
    const resume = () => {
      if (document.visibilityState === 'visible') document.documentElement.removeAttribute('data-app-shield');
      else end();
    };
    window.addEventListener('lw:app-lock', conceal);
    window.addEventListener('pagehide', conceal);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      mounted.current = false;
      generation.current += 1;
      session.current = null;
      acceptedLogin.current = null;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      window.removeEventListener('lw:app-lock', conceal);
      window.removeEventListener('pagehide', conceal);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [end]);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(end, Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt, end]);

  const request = useCallback<AdminRequest>(async <T,>(path: string, body?: unknown): Promise<T> => {
    // A new login supersedes any prior response awaiting its UI continuation.
    if (path === '/login') { generation.current += 1; acceptedLogin.current = null; }
    const expected = generation.current;
    const credential = session.current;
    const current = () => mounted.current && expected === generation.current && credential === session.current &&
      document.visibilityState === 'visible' && (!credential || Date.parse(credential.expiresAt) > Date.now());
    if (!current()) throw new DOMException('Phiên quản trị đã kết thúc.', 'AbortError');
    if (!credential && path !== '/login') { end(); throw new DOMException('Cần đăng nhập quản trị.', 'AbortError'); }
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const result = await adminRequest<T>(path, credential?.adminToken ?? null, body, controller.signal);
      if (!current()) throw new DOMException('Phiên quản trị đã kết thúc.', 'AbortError');
      if (path === '/login') acceptedLogin.current = { result, generation: expected };
      return result;
    } catch (error) {
      if (current() && credential && error instanceof AdminApiError && (error.status === 401 || error.status === 403)) end();
      throw error;
    } finally { controllers.current.delete(controller); }
  }, [end]);

  const begin = (result: AdminSession) => {
    if (acceptedLogin.current?.result !== result || acceptedLogin.current.generation !== generation.current ||
        !mounted.current || document.visibilityState !== 'visible' || !result.adminToken || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) return;
    acceptedLogin.current = null;
    generation.current += 1;
    session.current = result;
    setExpiresAt(result.expiresAt);
  };

  return <main className="admin-shell">
    <header className="admin-header"><div><p className="text-sm text-muted">Love Within</p><h1>Quản trị tài khoản</h1></div>
      {expiresAt && <button type="button" className="btn btn-outline" onClick={end}>Đăng xuất</button>}
    </header>
    {expiresAt && <><nav className="admin-nav" aria-label="Quản trị"><Link to="/admin">Khôi phục tài khoản</Link><Link to="/admin/change-password">Đổi mật khẩu admin</Link></nav><p className="text-sm text-muted">Phiên trong bộ nhớ, hết hạn lúc {new Date(expiresAt).toLocaleTimeString('vi-VN')}. Ẩn hoặc rời trang quản trị sẽ kết thúc phiên.</p></>}
    <Routes key={`${revision}:${location.key}`}>
      <Route path="/admin/login" element={expiresAt ? <Navigate to="/admin" replace /> : <AdminLoginPage request={request} onLogin={begin} />} />
      <Route path="/admin" element={expiresAt ? <AdminUsersPage request={request} /> : <Navigate to="/admin/login" replace />} />
      <Route path="/admin/change-password" element={expiresAt ? <AdminPasswordPage request={request} onChanged={end} /> : <Navigate to="/admin/login" replace />} />
      <Route path="*" element={<Navigate to={expiresAt ? '/admin' : '/admin/login'} replace />} />
    </Routes>
    <p className="text-sm text-muted">Chỉ có thông tin định danh cần thiết để hỗ trợ khôi phục. Không truy cập nội dung riêng tư.</p>
    <Link to="/login" className="text-sm" onClick={end}>Về ứng dụng</Link>
  </main>;
}
