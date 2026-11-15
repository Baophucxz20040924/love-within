import { useEffect, useId, useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { appLockEpoch, isAuthAttemptCurrent } from './store';
import './PinEntry.css';

interface Props { onComplete: (pin: string) => Promise<void> }

/** One input and one guarded submission path for touch, keyboard and paste. */
export function PinEntry({ onComplete }: Props) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const value = useRef('');
  const blocked = useRef(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      value.current = '';
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!retryAt) return;
    const interval = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) setRetryAt(0);
    }, 250);
    return () => clearInterval(interval);
  }, [retryAt]);
  const waiting = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const disabled = busy || invalid || waiting > 0;

  function clear() { value.current = ''; setPin(''); }
  async function verify(code: string) {
    if (blocked.current || retryAt > Date.now()) return;
    blocked.current = true;
    const request = ++attempt.current;
    const epoch = appLockEpoch(), generation = tokenStore.generation();
    const current = () => mounted.current && request === attempt.current &&
      isAuthAttemptCurrent(epoch) && tokenStore.isCurrent(generation);
    setBusy(true);
    setError('');
    // Keep only the dot count in state while the request is in flight.
    clear();
    let feedback = false;
    try {
      await onComplete(code);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiRequestError && err.code === 'INVALID_PIN') {
        feedback = true;
        setInvalid(true);
        setError('Mã chưa đúng. Hãy thử lại.');
        timer.current = setTimeout(() => {
          if (!current()) return;
          setInvalid(false);
          blocked.current = false;
          input.current?.focus({ preventScroll: true });
        }, 600);
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'Chưa kết nối được máy chủ. Hãy thử lại.');
        const details = err instanceof ApiRequestError ? err.details as { retryAfterSeconds?: unknown } | undefined : undefined;
        if (typeof details?.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds > 0) {
          setRetryAt(Date.now() + details.retryAfterSeconds * 1000);
          setNow(Date.now());
        }
      }
    } finally {
      if (current()) {
        setBusy(false);
        if (!feedback) blocked.current = false;
      }
    }
  }
  function update(next: string) {
    if (blocked.current || retryAt > Date.now()) return;
    const digits = next.replace(/[^0-9]/g, '').slice(0, 6);
    value.current = digits;
    setPin(digits);
    setError('');
    if (digits.length === 6) void verify(digits);
  }

  return <section className={`pin-entry${invalid ? ' pin-entry--invalid' : ''}`} aria-busy={busy}>
    <label className="pin-entry__label" htmlFor={id}>Nhập mã mở ứng dụng</label>
    <p className="pin-entry__hint" id={`${id}-hint`}>Nhập 6 số để tiếp tục</p>
    <div className="pin-entry__control">
      <input ref={input} id={id} className="pin-entry__input" type="password" inputMode="none" autoComplete="off"
        maxLength={6} value={pin} readOnly={disabled} aria-describedby={`${id}-hint ${id}-status`}
        aria-invalid={invalid || undefined} onChange={event => update(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
      <div className="pin-entry__dots" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => <span key={index} className={`pin-entry__dot${busy || invalid || index < pin.length ? ' is-filled' : ''}`} />)}
      </div>
    </div>
    <div className="pin-entry__status" id={`${id}-status`} aria-live="polite" aria-atomic="true">
      {busy ? 'Đang kiểm tra…' : waiting > 0 ? `Thử lại sau ${waiting} giây.` : error || 'Mã sẽ được kiểm tra tự động'}
    </div>
    <div className="pin-entry__keypad" role="group" aria-label="Bàn phím mã khóa">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'delete'].map((digit, index) => digit ?
        <button key={digit} type="button" className={`pin-entry__key${digit === 'delete' ? ' pin-entry__key--delete' : ''}`}
          disabled={disabled} aria-label={digit === 'delete' ? 'Xóa một số' : digit}
          onClick={() => {
            update(digit === 'delete' ? value.current.slice(0, -1) : value.current + digit);
            input.current?.focus({ preventScroll: true });
          }}>
          {digit === 'delete' ? <svg aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5h12v14H9L2 12 9 5Z" /><path d="m12 9 6 6m0-6-6 6" /></svg> : digit}
        </button> : <span key={`space-${index}`} />)}
    </div>
  </section>;
}
