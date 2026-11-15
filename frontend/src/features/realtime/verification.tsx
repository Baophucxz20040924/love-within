import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { setMask, setVerificationHost } from '../privacy/mask';
import { VerificationScreen } from './VerificationScreen';

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
  setMask('verification', next !== 'clear');
  status = next;
  for (const listener of listeners) listener();
}

/** The independent hidden-space lock remains authoritative when access verification finishes. */
export function RealtimeBoundary({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeVerification, getVerificationStatus, () => 'clear' as Status);
  return <>
    {children}
    {state !== 'clear' && statusHost && createPortal(<VerificationScreen status={state} onRetry={() => retry?.()} />, statusHost)}
  </>;
}
