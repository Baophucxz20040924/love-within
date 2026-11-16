import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { newPasswordError } from '../features/auth/passwordPolicy';
import { appLockEpoch, isAuthAttemptCurrent } from '../features/appLock/store';
import { ApiRequestError } from '../lib/apiClient';
import '../features/auth/recovery.css';

export function PasswordChangePage() {
  const { passwordChange, completePasswordChange, cancelPasswordChange, isAuthenticated, space } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [cancelPasswordChange]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const invalid = newPasswordError(password, confirmation);
    if (invalid) { setError(invalid); return; }
    const epoch = appLockEpoch();
    setBusy(true); setError(null);
    try {
      await completePasswordChange(password, confirmation);
    } catch (cause) {
      if (!mounted.current || !isAuthAttemptCurrent(epoch)) return;
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      if (cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403)) {
        cancelPasswordChange();
        return;
      }
      setError(cause instanceof ApiRequestError ? cause.message : 'Không nhận được kết quả. Nếu mật khẩu đã đổi, hãy đăng nhập bằng mật khẩu mới; không gửi lại tự động.');
    } finally {
      if (mounted.current) { setBusy(false); setPassword(''); setConfirmation(''); }
    }
  }

  if (!passwordChange) return <Navigate to={isAuthenticated ? (space === 'friends' ? '/friends' : '/') : '/login'} replace />;
  return <main className="recovery-page">
    <header className="stack"><p className="text-sm text-muted">Love Within · Khôi phục tài khoản</p><h1>Đặt mật khẩu mới</h1><p>Mật khẩu tạm chỉ dùng để xác minh. Bạn cần đổi mật khẩu trước khi vào ứng dụng; mã PIN của từng không gian vẫn được giữ.</p></header>
    <form className="card form recovery-card" onSubmit={submit}>
      <label className="field"><span className="field__label">Mật khẩu mới</span><input className="input" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
      <label className="field"><span className="field__label">Xác nhận mật khẩu mới</span><input className="input" type="password" autoComplete="new-password" required minLength={8} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></label>
      <p className="field__hint">Ít nhất 8 ký tự, tối đa 72 byte UTF-8; không trùng mật khẩu tạm.</p>
      <p className="text-sm text-muted">Quyền đổi mật khẩu hết hạn lúc {new Date(passwordChange.expiresAt).toLocaleTimeString('vi-VN')}. Rời trang hoặc ẩn ứng dụng sẽ yêu cầu đăng nhập lại.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Đang đổi mật khẩu…' : 'Đổi mật khẩu và tiếp tục'}</button>
      <button className="btn btn-ghost btn-block" type="button" onClick={cancelPasswordChange}>Hủy và về đăng nhập</button>
    </form>
  </main>;
}
