import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';

const PIECES = ['🎉', '✨', '💖', '🎊', '⭐', '💞', '🎉', '✨', '🎊', '💖', '⭐', '🎉'];
const DURATION_MS = 2400;

/**
 * A short burst of emoji rising from the bottom of the screen when an item is done. Decorative only (aria-hidden,
 * no pointer events); nothing at all with "reduce motion".
 */
export function Celebration() {
  const [on, setOn] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), DURATION_MS);
    return () => window.clearTimeout(t);
  }, [on]);

  if (!on) return null;
  return createPortal(
    <div className="bk-party" aria-hidden="true">
      {PIECES.map((p, i) => (
        <span
          key={i}
          className="bk-party__piece"
          style={
            {
              '--x': `${6 + ((i * 83) % 88)}%`,
              '--delay': `${(i % 6) * 70}ms`,
              '--drift': `${((i * 37) % 60) - 30}px`,
              '--size': `${22 + ((i * 7) % 14)}px`,
            } as CSSProperties
          }
        >
          {p}
        </span>
      ))}
    </div>,
    document.body,
  );
}
