import { useEffect, useState, useSyncExternalStore } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { NudgeKind } from '../../lib/types';
import { NUDGE_COOLDOWN_SEC, nudgesApi } from './api';
import { nudgeOf } from './constants';

// The 30 s wait lives in this module, so leaving Home and coming back keeps the countdown. After a reload it is gone;
// the server then answers 429 NUDGE_TOO_SOON with retryAfter, which starts the countdown again.
const cooldown = { until: 0, listeners: new Set<() => void>() };
const subscribe = (l: () => void) => {
  cooldown.listeners.add(l);
  return () => cooldown.listeners.delete(l);
};
const getUntil = () => cooldown.until;
function startCooldown(seconds: number) {
  cooldown.until = Date.now() + seconds * 1000;
  cooldown.listeners.forEach((l) => l());
}

const HINT_KEY = 'lw.nudgeHint';
/** The first send on this device also says how to pick another kind. */
function takeHint(): boolean {
  try {
    if (localStorage.getItem(HINT_KEY)) return false;
    localStorage.setItem(HINT_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

function retryAfterOf(err: ApiRequestError): number {
  const s = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
  return typeof s === 'number' && s > 0 ? Math.min(s, NUDGE_COOLDOWN_SEC) : NUDGE_COOLDOWN_SEC;
}

/** Send a nudge to the partner, with the 30 s countdown shared by every heart button on the page. */
export function useNudgeSender(partnerName: string) {
  const toast = useToast();
  const until = useSyncExternalStore(subscribe, getUntil);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const left = until - Date.now();
    if (left <= 0) return;
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    const end = window.setTimeout(() => {
      window.clearInterval(tick);
      setNow(Date.now());
    }, left + 30);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(end);
    };
  }, [until]);

  const mutation = useMutation({
    mutationFn: (kind: NudgeKind) => nudgesApi.send(kind),
    onSuccess: (sent) => {
      startCooldown(NUDGE_COOLDOWN_SEC);
      navigator.vibrate?.(15);
      const n = nudgeOf(sent.kind);
      toast.success(`${n.emoji} Đã gửi tới ${partnerName}${takeHint() ? '. Giữ nút tim để chọn ôm, hôn…' : ''}`);
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'NUDGE_TOO_SOON') {
        startCooldown(retryAfterOf(err));
        toast.info(err.message);
        return;
      }
      toast.error(err instanceof ApiRequestError ? err.message : 'Chưa gửi được, thử lại nhé.');
    },
  });

  const secondsLeft = Math.max(0, Math.ceil((until - now) / 1000));
  return {
    send: (kind: NudgeKind) => {
      if (secondsLeft > 0 || mutation.isPending) return;
      mutation.mutate(kind);
    },
    secondsLeft,
    busy: mutation.isPending,
    /** Waiting or sending: the heart buttons are disabled. */
    blocked: secondsLeft > 0 || mutation.isPending,
  };
}

export type NudgeSender = ReturnType<typeof useNudgeSender>;
