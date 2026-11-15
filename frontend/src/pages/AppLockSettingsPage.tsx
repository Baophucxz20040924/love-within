import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorState, Loading, Page } from '../components/StatusViews';
import { appLockEpoch, applyOwnLockSettings, isAppLockCurrent, isAppLocked, refreshLockSettings, subscribeAppLock } from '../features/appLock/store';
import { apiRequest, ApiRequestError } from '../lib/apiClient';
import { tokenStore } from '../lib/tokenStore';
import { getVerificationStatus, subscribeVerification } from '../features/realtime/verification';

type Space = 'couple' | 'friends';
type LockSettings = { couple: boolean; friends: boolean; revision: number };
type Mode = 'edit' | 'disable' | null;

/** Settings are account-wide, but this page only reveals the current space. */
export function AppLockSettingsPage({ space }: { space: Space }) {
  return <LockSettingsPage key={space} space={space} />;
}

function LockSettingsPage({ space }: { space: Space }) {
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [pin, setPin] = useState('');
  const [repeatPin, setRepeatPin] = useState('');
  const [password, setPassword] = useState('');
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);

  const clearCredentials = useCallback(() => {
    setPin('');
    setRepeatPin('');
    setPassword('');
  }, []);

  const startRequest = useCallback(() => {
    const id = ++sequence.current;
    const epoch = appLockEpoch();
    const generation = tokenStore.generation();
    return () => mounted.current && id === sequence.current && document.visibilityState === 'visible'
      && isAppLockCurrent(epoch) && tokenStore.isCurrent(generation);
  }, []);

  const load = useCallback(async (message = '') => {
    const current = startRequest();
    setLoading(true);
    setError('');
    try {
      const result = await apiRequest<LockSettings>('/privacy-lock');
      if (!current()) return;
      setSettings(result);
      setNotice(message);
    } catch (err) {
      if (!current()) return;
      setSettings(null);
      setError(err instanceof ApiRequestError ? err.message : 'Không tải được cài đặt. Hãy kiểm tra kết nối mạng.');
    } finally {
      if (current()) setLoading(false);
    }
  }, [startRequest]);

  useEffect(() => {
    mounted.current = true;
    const blocked = () => isAppLocked() || getVerificationStatus() !== 'clear';
    if (document.visibilityState === 'visible' && !blocked()) void load();
    let wasBlocked = blocked();
    const onGate = () => {
      const next = blocked();
      if (wasBlocked && !next && document.visibilityState === 'visible') void load();
      wasBlocked = next;
    };
    const unsubscribe = subscribeAppLock(onGate);
    const unsubscribeVerification = subscribeVerification(onGate);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        ++sequence.current;
        pending.current = false;
        clearCredentials();
        setMode(null);
        setBusy(false);
        setSettings(null);
        setNotice('');
        setError('');
        setLoading(true);
      } else if (!blocked()) {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      unsubscribeVerification();
      mounted.current = false;
      ++sequence.current;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [clearCredentials, load]);

  function selectMode(next: Mode) {
    clearCredentials();
    setError('');
    setNotice('');
    setMode(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || !mode || pending.current) return;
    if (!password) {
      setError('Hãy nhập mật khẩu tài khoản.');
      return;
    }
    if (mode === 'edit' && (!/^[0-9]{6}$/.test(pin) || pin !== repeatPin)) {
      setError('Mã PIN phải gồm đúng 6 chữ số và hai lần nhập phải giống nhau.');
      return;
    }
    const current = startRequest();
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<LockSettings>(`/privacy-lock/${space}`, {
        method: mode === 'disable' ? 'DELETE' : 'PUT',
        body: mode === 'disable'
          ? { password, revision: settings.revision }
          : { pin, password, revision: settings.revision },
      });
      if (!current()) return;
      clearCredentials();
      setMode(null);
      setSettings(result);
      try {
        applyOwnLockSettings(result);
        await refreshLockSettings();
        if (current()) setNotice('Đã lưu cài đặt khóa.');
      } catch {
        if (current()) setError('Đã lưu cài đặt nhưng chưa thể cập nhật trạng thái khóa. Hãy kiểm tra kết nối và tải lại trang.');
      }
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiRequestError && err.status === 409) {
        clearCredentials();
        setMode(null);
        pending.current = false;
        setBusy(false);
        await load('Cài đặt đã thay đổi ở nơi khác. Đã tải lại; hãy kiểm tra trước khi thử lại.');
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : 'Không thể lưu. Hãy kiểm tra kết nối mạng và thử lại.');
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <Page title="Khóa ứng dụng" back={space === 'couple' ? '/profile' : '/friends/me'}>
      <p className="text-sm text-muted">Tùy chọn này chỉ khóa không gian hiện tại. Mã PIN áp dụng cho tài khoản trên mọi thiết bị và cần kết nối mạng để sử dụng.</p>
      <p className="text-sm text-muted">Sau khi mở khóa, bạn sẽ về trang chủ. Nội dung đang soạn có thể không được giữ lại, kể cả khi ứng dụng chuyển vào nền lúc chọn ảnh hoặc tệp.</p>
      {loading ? <Loading label="Đang tải cài đặt…" /> : !settings ? (
        <ErrorState message={error || 'Kiểm tra kết nối mạng rồi thử lại.'} onRetry={() => void load()} />
      ) : (
        <div className="card stack">
          <p className="card__title">Khóa ứng dụng: {settings[space] ? 'Đang bật' : 'Đang tắt'}</p>
          {notice && <p className="field__hint" role="status">{notice}</p>}
          {error && <p className="form-feedback" role="alert">{error}</p>}
          {mode === null ? (
            <div className="stack">
              <button type="button" className="btn btn-primary btn-block" onClick={() => selectMode('edit')}>
                {settings[space] ? 'Đổi mã PIN' : 'Bật khóa'}
              </button>
              {settings[space] && <button type="button" className="btn btn-outline btn-block" onClick={() => selectMode('disable')}>Tắt khóa</button>}
            </div>
          ) : (
            <form className="form" onSubmit={(event) => void submit(event)}>
              {mode === 'disable' ? (
                <p>Bạn có chắc muốn tắt khóa cho không gian này? Nhập mật khẩu để xác nhận.</p>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">Mã PIN mới</span>
                    <input className="input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="new-password" value={pin} onChange={(event) => setPin(event.target.value)} disabled={busy} required />
                  </label>
                  <label className="field">
                    <span className="field__label">Nhập lại mã PIN</span>
                    <input className="input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="new-password" value={repeatPin} onChange={(event) => setRepeatPin(event.target.value)} disabled={busy} required />
                  </label>
                </>
              )}
              <label className="field">
                <span className="field__label">Mật khẩu tài khoản</span>
                <input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required />
              </label>
              <button className={`btn ${mode === 'disable' ? 'btn-danger' : 'btn-primary'} btn-block`} type="submit" disabled={busy}>
                {busy ? 'Đang lưu…' : mode === 'disable' ? 'Xác nhận tắt khóa' : 'Lưu mã PIN'}
              </button>
              <button className="btn btn-outline btn-block" type="button" disabled={busy} onClick={() => selectMode(null)}>Hủy</button>
            </form>
          )}
        </div>
      )}
    </Page>
  );
}
