import { useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { useToast } from '../components/Toast';
import { useAuth } from '../features/auth/AuthContext';
import { SecretBoat } from '../features/auth/SecretBoat';
import { AuthBackdrop } from '../features/auth/AuthBackdrop';
import { announceInvite } from '../features/friends/inviteResult';
import { ApiRequestError } from '../lib/apiClient';
import { isStandalone } from '../lib/installPrompt';

import { useSecretEntry } from '../features/auth/useSecretEntry';
import { enterHidden, isPrivacyCurrent, privacyEpoch } from '../features/privacy/store';

type Mode = 'login' | 'register';

/** Turn an API/network error into a clear Vietnamese message for the auth form. */
function messageForError(err: unknown, mode: Mode): string {
  if (!(err instanceof ApiRequestError)) {
    return 'Không kết nối được máy chủ, thử lại nhé.';
  }
  // Wrong email/password on login: backend returns 401 UNAUTHORIZED.
  if (err.status === 401 && mode === 'login') {
    return 'Email hoặc mật khẩu không đúng.';
  }
  // Too many attempts.
  if (err.status === 429) {
    return err.message || 'Bạn thử quá nhiều lần, vui lòng đợi một lát.';
  }
  // Validation failure (bad email format, empty password, etc.).
  // The backend now sends the specific field message as `message`.
  if (err.code === 'VALIDATION_ERROR' || err.status === 400) {
    return err.message || 'Vui lòng kiểm tra lại email và mật khẩu.';
  }
  return err.message || 'Có lỗi xảy ra, thử lại nhé.';
}

const COPY = {
  couple: {
    title: 'Love Within',
    tagline: 'A couple space for you and your partner.',
    footer: 'The Love Universe. built with ❤️ by Love Within.',
  },
  friends: {
    title: 'Dark Within',
    tagline: 'A space to share stories and connect with others.',
    footer: 'Raise your beer glass.',
  },
} as const;

interface Props {
  /** couple = normal login (pink). friends = hidden login of the friends space (blue theme, set by App). */
  variant?: 'couple' | 'friends';
  /** Opened from an invite link (/j/<code>): show who invites and become friends with them after login. */
  invite?: { code: string; inviterName: string };
  initialMode?: Mode;
}

export function AuthPage({ variant = 'couple', invite, initialMode = 'login' }: Props) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[variant];
  const { boatOpen, markRef, onHeartTap, revealBoat, dismissBoat, boardBoat } = useSecretEntry(
    variant === 'couple' && mode === 'login' && !invite && !busy,
    () => { if (enterHidden()) navigate('/friends/login'); },
    `${mode}:${variant}:${invite?.code ?? ''}`,
  );
  function onSubmitClick(e: MouseEvent<HTMLButtonElement>) {
    if (revealBoat()) e.preventDefault();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || revealBoat()) return;
    const epoch = privacyEpoch();
    setError(null);
    setBusy(true);
    try {
      const opts = invite ? { inviteCode: invite.code } : undefined;
      const joined =
        mode === 'login' ? await login(email, password, variant, opts) : await register(email, password, displayName, variant, opts);
      if (isPrivacyCurrent(epoch)) announceInvite(joined, toast);
    } catch (err) {
      if (isPrivacyCurrent(epoch)) setError(messageForError(err, mode));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`auth auth--entry${variant === 'friends' ? ' auth--friends' : ''}`}>
      <AuthBackdrop friends={variant === 'friends'} />
      <div className="auth__brand">
        {variant === 'couple' ? (
          <button ref={markRef} className="brand-mark auth__heart" type="button" aria-label="Trái tim" onClick={onHeartTap}>
            <Icon name="heart" size={36} strokeWidth={0} />
          </button>
        ) : (
          <span className="brand-mark" aria-hidden="true"><Icon name="users" size={36} strokeWidth={2.2} /></span>
        )}
        <h1 className="auth__title">{copy.title}</h1>
        <p className="auth__tagline">{copy.tagline}</p>
      </div>

      {variant === 'couple' && mode === 'login' && !invite && (
        <div className="auth__boat-lane">
          {boatOpen && <SecretBoat onClose={dismissBoat} onBoard={boardBoat} />}
        </div>
      )}

      {invite && (
        <p className="callout invite-banner" role="note">
          <Icon name="userPlus" size={18} />
          <span>
            <strong>{invite.inviterName}</strong> mời bạn vào hội. Đăng nhập hoặc tạo tài khoản để hai bạn thành bạn bè.
          </span>
        </p>
      )}

      <div className="card stack" style={{ gap: 16, padding: 20 }}>
        <SegmentedControl
          mode="radio"
          disabled={busy}
          ariaLabel="Chế độ"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: 'login', label: 'Đăng nhập' },
            { value: 'register', label: 'Đăng ký' },
          ]}
        />

        <form
          className="form"
          onSubmit={onSubmit}
          noValidate={false}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && revealBoat()) event.preventDefault();
          }}
        >
          {mode === 'register' && (
            <label className="field">
              <span className="field__label">Tên hiển thị</span>
              <input disabled={busy} className="input" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} autoComplete="nickname" placeholder="VD: Thu Hà" />
            </label>
          )}
          <label className="field">
            <span className="field__label">Email</span>
            <input disabled={busy} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" placeholder="ban@email.com" />
          </label>
          <label className="field">
            <span className="field__label">Mật khẩu</span>
            <div className="input-wrap">
              <input
                disabled={busy}
                className="input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'register' ? 8 : undefined}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                className="icon-btn input-wrap__action"
                disabled={busy}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={20} />
              </button>
            </div>
            {mode === 'register' && <span className="field__hint">Tối thiểu 8 ký tự.</span>}
          </label>

          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" size={18} /> {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={onSubmitClick}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>
      </div>

      <p className="text-sm text-muted center">{copy.footer}</p>
      {/* N5: only on the normal login, and not inside the installed app. */}
      {variant === 'couple' && !isStandalone() && (
        <Link to="/install" className="auth__install">
          <Icon name="smartphone" size={18} /> Cài app lên điện thoại
        </Link>
      )}
      {variant === 'friends' && (
        <Link to="/login" replace className="auth__back">
          <Icon name="chevronLeft" size={18} /> Về trang đăng nhập Love Within
        </Link>
      )}
    </main>
  );
}
