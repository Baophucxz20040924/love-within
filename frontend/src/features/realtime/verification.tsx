import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { setAppMask, setVerificationHost } from '../appLock/mask';

type Status = 'clear' | 'checking' | 'failed';
let status: Status = 'clear';
let retry: (() => void) | undefined;
let statusHost: HTMLElement | null = null;
const listeners = new Set<() => void>();
export function subscribeVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getVerificationStatus(): Status { return status; }
export function setVerification(next: Status, onRetry?: () => void): void {
  retry = onRetry;
  if (next !== 'clear' && !statusHost) {
    statusHost = document.createElement('div');
    statusHost.setAttribute('data-realtime-verification', '');
    setVerificationHost(statusHost);
    document.body.appendChild(statusHost);
  }
  setAppMask('verification', next !== 'clear');
  status = next;
  for (const listener of listeners) listener();
}

/** Verification and the optional PIN lock have independent mask lifetimes. */
export function RealtimeBoundary({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeVerification, getVerificationStatus, () => 'clear' as Status);
  return <>
    {children}
    {state !== 'clear' && statusHost && createPortal(<main className="app-content" role="status" aria-live="polite">
      <p>{state === 'checking' ? 'Đang kiểm tra lại quyền truy cập…' : 'Chưa kiểm tra được quyền truy cập. Nội dung được tạm ẩn để bảo vệ dữ liệu.'}</p>
      {state === 'failed' && <button type="button" className="btn btn-primary" onClick={() => retry?.()}>Thử lại</button>}
    </main>, statusHost)}
  </>;
}
