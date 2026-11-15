import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isAppLocked, subscribeAppLock } from '../features/appLock/store';
import { Icon, type IconName } from './Icon';
import './interactions.css';

type Kind = 'success' | 'error' | 'info';
interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
  action?: ToastAction;
  durationMs: number;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  /** Info toast with one button (e.g. "Hoàn tác"), shown for `durationMs` (default 5 s), excluding hover/focus time. */
  action: (message: string, action: ToastAction, durationMs?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ICON: Record<Kind, IconName> = { success: 'check', error: 'alert', info: 'bell' };

function Toast({ item, dismiss }: { item: ToastItem; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.durationMs);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [dismiss, item.id, paused]);

  return (
    <div
      className={`toast toast--interactive toast--${item.kind}${item.action ? ' toast--action' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon name={ICON[item.kind]} size={18} className="toast__icon" />
      <span
        className="toast__text"
        role={item.kind === 'error' ? 'alert' : 'status'}
        aria-atomic="true"
      >
        {item.message}
      </span>
      {item.action && (
        <button
          type="button"
          className="toast__btn"
          onClick={() => {
            dismiss(item.id);
            item.action?.onClick();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast__dismiss"
        aria-label="Đóng thông báo"
        onClick={() => dismiss(item.id)}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

/** Auto-dismiss pauses during hover/focus. Three-item soft limit never evicts actionable toasts. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  useEffect(() => subscribeAppLock(() => { if (isAppLocked()) setItems([]); }), []);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback(
    (kind: Kind, message: string, action?: ToastAction, durationMs?: number) => {
      if (isAppLocked()) return;
      const id = ++seq.current;
      const duration = durationMs ?? (kind === 'error' || action ? 5000 : 3500);
      setItems((xs) => {
        const next = [...xs, {
          id, kind, message, action,
          durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 5000,
        }];
        while (next.length > 3) {
          const disposable = next.findIndex((item) => !item.action && item.id !== id);
          // Overflow rather than discard an action or suppress the incoming notification.
          if (disposable === -1) break;
          next.splice(disposable, 1);
        }
        return next;
      });
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => show('success', m),
      error: (m) => show('error', m),
      info: (m) => show('info', m),
      action: (m, a, ms) => show('info', m, a, ms ?? 5000),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toaster">
        {items.map((item) => <Toast key={item.id} item={item} dismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
