import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ADMIN_EMAIL, AdminApiError, adminErrorMessage, type AdminSession, type AdminUser, type PasswordResetResult } from './api';
import type { AdminRequest } from './AdminApp';
import { newPasswordError } from '../auth/passwordPolicy';

function usePageLifetime() {
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current += 1;
    return () => { lifetime.current += 1; };
  }, []);
  return () => {
    const expected = lifetime.current;
    return () => lifetime.current === expected && document.visibilityState === 'visible';
  };
}
function aborted(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }

export function AdminLoginPage({ request, onLogin }: { request: AdminRequest; onLogin: (session: AdminSession) => void }) {
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = usePageLifetime();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim().toLowerCase() !== ADMIN_EMAIL) { setError('Trang này chỉ dành cho tài khoản quản trị được cấp quyền.'); return; }
    const current = capture();
    setBusy(true); setError(null);
    try {
      const result = await request<AdminSession>('/login', { email: email.trim().toLowerCase(), password });
      if (current()) onLogin(result);
    } catch (cause) { if (current() && !aborted(cause)) setError(adminErrorMessage(cause)); }
    finally { if (current()) { setBusy(false); setPassword(''); } }
  }
  return <section className="card admin-card stack">
    <h2>Đăng nhập quản trị</h2><p className="text-muted">Phiên quản trị độc lập với tài khoản trong ứng dụng. Tải lại trang sẽ yêu cầu đăng nhập lại.</p>
    <form className="form" onSubmit={submit}>
      <label className="field"><span className="field__label">Email quản trị</span><input className="input" type="email" autoComplete="username" required value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></label>
      <label className="field"><span className="field__label">Mật khẩu</span><input className="input" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập quản trị'}</button>
    </form>
  </section>;
}

export function AdminUsersPage({ request }: { request: AdminRequest }) {
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<AdminUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<PasswordResetResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const capture = usePageLifetime();
  const secretRef = useRef<PasswordResetResult | null>(null);
  const discardSecret = () => { secretRef.current = null; setSecret(null); };
  useEffect(() => {
    if (!secret) return;
    const timer = window.setTimeout(() => { secretRef.current = null; setSecret(null); setNotice('Mật khẩu tạm đã hết hạn.'); }, Math.max(0, Date.parse(secret.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [secret]);
  useEffect(() => () => { secretRef.current = null; }, []);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const current = capture();
    discardSecret(); setUser(null); setConfirmed(false); setAdminPassword(''); setSearched(false); setError(null); setNotice(null); setBusy(true);
    try {
      const result = await request<{ user: AdminUser | null }>(`/users?email=${encodeURIComponent(email.trim().toLowerCase())}`);
      if (current()) { setUser(result.user); setSearched(true); }
    } catch (cause) { if (current() && !aborted(cause)) setError(adminErrorMessage(cause)); }
    finally { if (current()) setBusy(false); }
  }

  async function reset(event: FormEvent) {
    event.preventDefault();
    if (busy || !user || !confirmed || !adminPassword) return;
    const current = capture();
    const target = user;
    setBusy(true); setError(null); setNotice(null); discardSecret();
    const currentAdminPassword = adminPassword;
    setAdminPassword('');
    try {
      const result = await request<PasswordResetResult>(`/users/${encodeURIComponent(target.id)}/reset-password`, {
        expectedCredentialVersion: target.credentialVersion, currentAdminPassword,
      });
      if (!current()) return;
      // Only this response can display the secret. There is no cache or endpoint for viewing it again.
      if (!result.temporaryPassword || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error('Invalid reset response');
      secretRef.current = result; setSecret(result);
      setUser({ ...target, credentialVersion: result.credentialVersion, mustChangePassword: true, temporaryPasswordExpiresAt: result.expiresAt });
    } catch (cause) {
      if (!current() || aborted(cause)) return;
      // Even a 5xx/malformed response may follow a committed reset. Always require a fresh lookup + confirmation.
      setUser(null); setSearched(false);
      if (cause instanceof AdminApiError && cause.status < 500) setError(`${cause.message} Hãy tìm lại tài khoản và xác nhận trạng thái trước khi tiếp tục.`);
      else setError('Không nhận được kết quả: mật khẩu có thể đã được đặt lại. Không tự động thử lại. Hãy tìm lại đúng email, kiểm tra trạng thái rồi xác nhận một lần đặt lại mới nếu cần mật khẩu khác.');
    } finally { if (current()) { setBusy(false); setConfirmed(false); } }
  }

  async function copy() {
    const value = secretRef.current;
    if (!value || Date.parse(value.expiresAt) <= Date.now()) { discardSecret(); return; }
    const current = capture();
    try {
      await navigator.clipboard.writeText(value.temporaryPassword);
      if (current() && secretRef.current === value) setNotice('Đã sao chép. Gửi riêng cho đúng người nhận và xóa khỏi clipboard sau khi gửi.');
    } catch { if (current() && secretRef.current === value) setNotice('Không thể sao chép tự động. Bạn có thể chọn và sao chép mật khẩu đang hiển thị.'); }
  }

  return <>
    <section className="card admin-card stack"><h2>Tìm chính xác tài khoản</h2><p className="text-muted">Nhập đầy đủ email. Kiểm tra tên và email với người yêu cầu trước khi đặt lại.</p>
      <form className="form" onSubmit={search}><label className="field"><span className="field__label">Email người dùng</span><input className="input" type="email" required autoComplete="off" value={email} disabled={busy} onChange={e => { setEmail(e.target.value); setUser(null); setSearched(false); setConfirmed(false); setAdminPassword(''); discardSecret(); setNotice(null); }} /></label><button className="btn btn-outline" disabled={busy}>{busy ? 'Đang xử lý…' : 'Tìm tài khoản'}</button></form>
      {searched && !user && <p role="status">Không tìm thấy tài khoản có email này.</p>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {user && <section className="card admin-card stack"><h2>{user.displayName}</h2><dl className="admin-account"><dt>Email</dt><dd>{user.email}</dd><dt>Mã tài khoản</dt><dd>{user.id}</dd><dt>Khôi phục</dt><dd>{user.mustChangePassword ? 'Đang chờ đổi mật khẩu' : 'Không có yêu cầu đổi mật khẩu'}</dd>{user.temporaryPasswordExpiresAt && <><dt>Hạn mật khẩu tạm</dt><dd>{new Date(user.temporaryPasswordExpiresAt).toLocaleString('vi-VN')}</dd></>}</dl>
      {!secret && <form className="form" onSubmit={reset}>
        <p>Đặt lại sẽ kết thúc các phiên cũ, tạo mật khẩu tạm dùng trong 24 giờ và buộc người dùng đổi trước khi vào app. PIN không bị thay đổi.</p>
        <label className="admin-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} required /><span>Tôi đã xác minh đúng tài khoản <strong>{user.email}</strong> và muốn đặt lại mật khẩu.</span></label>
        <label className="field"><span className="field__label">Xác nhận mật khẩu admin hiện tại</span><input className="input" type="password" autoComplete="current-password" required value={adminPassword} disabled={busy} onChange={e => setAdminPassword(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !confirmed}>{busy ? 'Đang đặt lại…' : 'Xác nhận đặt lại mật khẩu'}</button>
      </form>}
    </section>}
    {secret && <section className="card admin-card admin-secret stack" aria-labelledby="temporary-secret-heading">
      <h2 id="temporary-secret-heading">Mật khẩu tạm · chỉ hiển thị lần này</h2><p>Gửi riêng cho đúng người dùng. Không gửi qua thông báo. Đóng, chuyển trang hoặc ẩn ứng dụng sẽ xóa nội dung này; không thể xem lại.</p>
      <output className="admin-secret__value" aria-label="Mật khẩu tạm">{secret.temporaryPassword}</output>
      <p className="text-sm">Hết hạn: {new Date(secret.expiresAt).toLocaleString('vi-VN')}</p>
      <div className="admin-actions"><button className="btn btn-primary" type="button" onClick={() => void copy()}>Sao chép mật khẩu</button><button className="btn btn-outline" type="button" onClick={() => { discardSecret(); setNotice('Đã xóa mật khẩu khỏi trang. Không thể xem lại.'); }}>Đã lưu riêng · đóng</button></div>
    </section>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </>;
}

export function AdminPasswordPage({ request, onChanged }: { request: AdminRequest; onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = usePageLifetime();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const invalid = newPasswordError(newPassword, confirmPassword);
    if (invalid) { setError(invalid); return; }
    const current = capture();
    setBusy(true); setError(null);
    try {
      await request<{ changed: true }>('/change-password', { currentPassword, newPassword, confirmPassword });
      if (current()) onChanged();
    } catch (cause) {
      if (current() && !aborted(cause)) setError(cause instanceof AdminApiError ? cause.message : 'Không nhận được kết quả; mật khẩu có thể đã đổi. Hãy đăng xuất và đăng nhập bằng mật khẩu mới trước khi thử tiếp.');
    } finally { if (current()) { setBusy(false); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); } }
  }
  return <section className="card admin-card stack"><h2>Đổi mật khẩu admin</h2><p>Đổi thành công sẽ kết thúc phiên quản trị hiện tại. Hãy dùng mật khẩu mới để đăng nhập lại.</p>
    <form className="form" onSubmit={submit}>
      <label className="field"><span className="field__label">Mật khẩu hiện tại</span><input className="input" type="password" autoComplete="current-password" required disabled={busy} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
      <label className="field"><span className="field__label">Mật khẩu mới</span><input className="input" type="password" autoComplete="new-password" required minLength={8} disabled={busy} value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
      <label className="field"><span className="field__label">Xác nhận mật khẩu mới</span><input className="input" type="password" autoComplete="new-password" required minLength={8} disabled={busy} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>
      <p className="field__hint">Ít nhất 8 ký tự, tối đa 72 byte UTF-8.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Đang đổi…' : 'Đổi mật khẩu và đăng xuất'}</button>
    </form>
  </section>;
}
