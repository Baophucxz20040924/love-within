import { useEffect, useState } from 'react';
import { countdownParts } from './constants';

/** Current time, re-read every `intervalMs` while `enabled` (client-side ticking for live countdowns). */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** "12 ngày · 4 giờ · 20 phút" as three cells (for "Gặp nhau" events with a time). */
export function CountdownCells({ ms }: { ms: number }) {
  const { days, hours, minutes } = countdownParts(ms);
  const cells = [
    { value: days, unit: 'ngày' },
    { value: hours, unit: 'giờ' },
    { value: minutes, unit: 'phút' },
  ];
  return (
    <div className="ev-count" role="timer" aria-label={`Còn ${days} ngày ${hours} giờ ${minutes} phút`}>
      {cells.map((c) => (
        <span key={c.unit} className="ev-count__cell" aria-hidden="true">
          <span className="ev-count__num">{c.value}</span>
          <span className="ev-count__unit">{c.unit}</span>
        </span>
      ))}
    </div>
  );
}
