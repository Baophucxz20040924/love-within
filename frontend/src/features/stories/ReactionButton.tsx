import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../../components/Icon';
import type { ReactionType } from '../../lib/types';
import { REACTIONS, reactionOf } from './constants';

interface Props {
  mine: ReactionType | null;
  onReact: (type: ReactionType | null) => void;
}

const LONG_PRESS_MS = 420;

/**
 * Facebook-style "Thích" button: tap toggles 👍, long-press (or hover with a mouse,
 * right-click, or ↑ on the keyboard) opens the reaction picker.
 */
export function ReactionButton({ mine, onReact }: Props) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function startPress(delay: number) {
    window.clearTimeout(timer.current);
    longPressed.current = false;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      setOpen(true);
      navigator.vibrate?.(10);
    }, delay);
  }
  const cancelPress = () => window.clearTimeout(timer.current);

  function onPointerDown(e: ReactPointerEvent) {
    if (e.pointerType !== 'mouse') startPress(LONG_PRESS_MS);
  }
  function onPointerEnter(e: ReactPointerEvent) {
    if (e.pointerType === 'mouse') startPress(550); // hover intent, like facebook.com
  }

  function onClick() {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    setOpen(false);
    onReact(mine ? null : 'like');
  }

  const r = mine ? reactionOf(mine) : null;

  return (
    <div className="react" ref={wrapRef}>
      {open && (
        <div className="react__picker" role="menu" aria-label="Chọn cảm xúc">
          {REACTIONS.map((x) => (
            <button
              key={x.type}
              type="button"
              role="menuitem"
              className={`react__opt${mine === x.type ? ' is-active' : ''}`}
              aria-label={x.label}
              title={x.label}
              onClick={() => {
                setOpen(false);
                onReact(mine === x.type ? null : x.type);
              }}
            >
              <span aria-hidden="true">{x.emoji}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`post-action${r ? ' is-reacted' : ''}`}
        style={r ? { color: r.color } : undefined}
        aria-pressed={Boolean(mine)}
        aria-haspopup="menu"
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        onClick={onClick}
      >
        {r ? (
          <span className="post-action__emoji" aria-hidden="true">
            {r.emoji}
          </span>
        ) : (
          <Icon name="thumbsUp" size={20} />
        )}
        <span>{r ? r.label : 'Thích'}</span>
      </button>
    </div>
  );
}
