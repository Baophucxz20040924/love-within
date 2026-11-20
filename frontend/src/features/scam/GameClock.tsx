import { useEffect, useState } from 'react';

export function GameClock({ until }: { until: number }) {
  const remaining = () => Math.max(0, Math.ceil((until - performance.now()) / 1000));
  const [seconds, setSeconds] = useState(remaining);
  useEffect(() => {
    const tick = () => setSeconds(remaining());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return <span className="scam-clock" aria-label="Thời gian còn lại">Còn {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>;
}
