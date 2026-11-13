import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { timeAgo } from '../../lib/format';
import type { NudgeKind, PulseNudges } from '../../lib/types';
import { NUDGES, nudgeOf, receivedLine } from './constants';
import type { NudgeSender } from './useNudgeSender';

const LONG_PRESS_MS = 450;

/**
 * After a long-press with a finger the browser may still send a mouse-down and a click where the finger lifted. By then
 * the sheet's backdrop is on top: the click would close the sheet at once and the mouse-down would pull focus out of it.
 * Swallow those two (only near the press point, so a quick tap on an option of the sheet still counts).
 */
function swallowClickNear(x: number, y: number) {
  const stop = (e: MouseEvent) => {
    if (Math.abs(e.clientX - x) > 24 || Math.abs(e.clientY - y) > 24) return;
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('mousedown', stop, { capture: true });
  document.addEventListener('click', stop, { capture: true });
  window.setTimeout(() => {
    document.removeEventListener('mousedown', stop, { capture: true });
    document.removeEventListener('click', stop, { capture: true });
  }, 600);
}

/**
 * Small heart in the Hero's corner (CP5). Tap = 💗 Nhớ. Long-press (also right-click, the context-menu key or ↑) opens
 * the sheet with 💗 Nhớ · 🤗 Ôm · 😘 Hôn · 💭 Đang nghĩ về bạn. During the 30 s wait it shows the seconds left.
 */
export function NudgeHeart({ sender, partnerName, onMore }: { sender: NudgeSender; partnerName: string; onMore: () => void }) {
  const timer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const [popKey, setPopKey] = useState(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function openMore() {
    window.clearTimeout(timer.current);
    onMore();
  }
  function onPointerDown() {
    window.clearTimeout(timer.current);
    longPressed.current = false;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      navigator.vibrate?.(10);
      onMore();
    }, LONG_PRESS_MS);
  }
  const cancelPress = () => window.clearTimeout(timer.current);
  function onPointerUp(e: ReactPointerEvent) {
    cancelPress();
    // A finger's pointer stays captured by this button, so the release lands here even with the sheet on top.
    if (longPressed.current) swallowClickNear(e.clientX, e.clientY);
  }
  function onClick() {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (sender.blocked) return;
    setPopKey((k) => k + 1);
    sender.send('miss');
  }
  function onContextMenu(e: ReactMouseEvent) {
    e.preventDefault();
    if (!longPressed.current) openMore();
  }
  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      openMore();
    }
  }

  const waiting = sender.secondsLeft > 0;
  const label = waiting
    ? `Chờ ${sender.secondsLeft} giây để gửi tiếp cho ${partnerName}. Giữ để xem các kiểu`
    : `Gửi 💗 Nhớ tới ${partnerName}. Giữ để chọn ôm, hôn hoặc đang nghĩ về bạn`;

  return (
    <button
      type="button"
      className={`hero-heart${waiting ? ' is-waiting' : ''}`}
      aria-label={label}
      title={waiting ? `Chờ ${sender.secondsLeft} giây` : `Nhớ ${partnerName} · giữ để chọn kiểu khác`}
      aria-haspopup="dialog"
      aria-disabled={sender.blocked}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {waiting ? (
        <span className="hero-heart__count num" aria-hidden="true">
          {sender.secondsLeft}
        </span>
      ) : (
        <span key={popKey} className={popKey ? 'hero-heart__icon is-pop' : 'hero-heart__icon'} aria-hidden="true">
          <Icon name="heart" size={22} />
        </span>
      )}
    </button>
  );
}

/** Long-press sheet: pick one of the four nudges. */
export function NudgeKindSheet({
  open,
  onClose,
  sender,
  partnerName,
}: {
  open: boolean;
  onClose: () => void;
  sender: NudgeSender;
  partnerName: string;
}) {
  function pick(kind: NudgeKind) {
    sender.send(kind);
    onClose();
  }
  return (
    <BottomSheet open={open} onClose={onClose} title={`Gửi tới ${partnerName}`}>
      <div className="stack">
        <div className="nudge-grid">
          {NUDGES.map((n) => (
            <button key={n.kind} type="button" className="mood-opt nudge-opt" disabled={sender.blocked} onClick={() => pick(n.kind)}>
              <span className="mood-opt__emoji" aria-hidden="true">
                {n.emoji}
              </span>
              <span>{n.label}</span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted" aria-live="polite">
          {sender.secondsLeft > 0
            ? `Chờ ${sender.secondsLeft} giây nữa để gửi tiếp.`
            : `Chạm một kiểu để gửi. Lần sau chỉ cần chạm nút tim là gửi 💗 Nhớ.`}
        </p>
      </div>
    </BottomSheet>
  );
}

/** Receiver: "Hà nhớ bạn 3 lần hôm nay · 10 phút trước" + "Nhớ lại 💗" (same 30 s wait as the heart). */
export function NudgeLine({ nudges, partnerName, sender }: { nudges: PulseNudges; partnerName: string; sender: NudgeSender }) {
  if (nudges.receivedToday < 1 || !nudges.lastAt) return null;
  const waiting = sender.secondsLeft > 0;
  return (
    <div className="hero-row hero-row--nudge">
      <p className="hero-row__text">
        <strong>{receivedLine(partnerName, nudges.receivedToday, nudges.lastKind)}</strong>
        <span className="hero-row__meta"> · {timeAgo(nudges.lastAt)}</span>
      </p>
      <button
        type="button"
        className="btn hero-row__back"
        aria-disabled={sender.blocked}
        onClick={() => sender.send('miss')}
        aria-label={waiting ? `Chờ ${sender.secondsLeft} giây để nhớ lại ${partnerName}` : `Nhớ lại ${partnerName}`}
      >
        {waiting ? `${sender.secondsLeft} giây` : 'Nhớ lại 💗'}
      </button>
    </div>
  );
}

// ── Floating hearts: once per new nudge received ──

const SEEN_PREFIX = 'lw.nudgeSeen.';
const FLOATS: { x: number; delay: number; size: number; drift: number }[] = [
  { x: 10, delay: 0, size: 26, drift: -14 },
  { x: 26, delay: 0.3, size: 20, drift: 10 },
  { x: 44, delay: 0.1, size: 30, drift: -6 },
  { x: 60, delay: 0.45, size: 22, drift: 12 },
  { x: 76, delay: 0.2, size: 26, drift: -10 },
  { x: 88, delay: 0.6, size: 18, drift: 6 },
  { x: 34, delay: 0.75, size: 18, drift: 8 },
  { x: 68, delay: 0.9, size: 20, drift: -8 },
];
const BURST_MS = 3600;

function readSeen(userId: string): string | null {
  try {
    return localStorage.getItem(SEEN_PREFIX + userId);
  } catch {
    return null;
  }
}
function writeSeen(userId: string, lastAt: string) {
  try {
    localStorage.setItem(SEEN_PREFIX + userId, lastAt);
  } catch {
    // storage disabled: the hearts may float again on the next open
  }
}

/**
 * Hearts float up through the Hero when a nudge newer than the last one seen on this device arrives (on opening the app,
 * or when the 30 s poll brings one). Not with "reduce motion"; the line under the Hero still says it.
 */
export function FloatingHearts({ userId, nudges }: { userId: string; nudges: PulseNudges | null | undefined }) {
  const [burst, setBurst] = useState<{ key: string; kind: NudgeKind } | null>(null);
  const lastAt = nudges && nudges.receivedToday > 0 ? nudges.lastAt : null;
  const kind = nudges?.lastKind ?? 'miss';

  useEffect(() => {
    if (!userId || !lastAt) return;
    const seen = readSeen(userId);
    if (seen && seen >= lastAt) return;
    writeSeen(userId, lastAt);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setBurst({ key: lastAt, kind });
  }, [userId, lastAt, kind]);

  useEffect(() => {
    if (!burst) return;
    const t = window.setTimeout(() => setBurst(null), BURST_MS);
    return () => window.clearTimeout(t);
  }, [burst]);

  if (!burst) return null;
  const emoji = nudgeOf(burst.kind).emoji;
  return (
    <div className="hero__hearts" aria-hidden="true" key={burst.key}>
      {FLOATS.map((f, i) => (
        <span
          key={i}
          className="hero__float"
          style={{ '--x': `${f.x}%`, '--delay': `${f.delay}s`, '--size': `${f.size}px`, '--drift': `${f.drift}px` } as CSSProperties}
        >
          {emoji}
        </span>
      ))}
    </div>
  );
}
