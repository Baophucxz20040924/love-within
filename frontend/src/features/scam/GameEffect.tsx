import { useEffect, useState, type CSSProperties } from 'react';
import type { GameReward } from './presentation';

const notes = [
  new URL('./assets/note-mint.svg', import.meta.url).href,
  new URL('./assets/note-gold.svg', import.meta.url).href,
];

export function GameEffect({ reward }: { reward: GameReward }) {
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const hide = () => { if (document.visibilityState !== 'visible') setVisible(false); };
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', hide);
    const timer = window.setTimeout(() => setVisible(false), 1800);
    return () => { window.clearTimeout(timer); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', hide); };
  }, []);
  if (!visible) return null;
  const lost = reward.kind === 'lost';
  return <div className={`scam-effect scam-effect--${reward.kind}`} data-reduced={reduced}>
    {!reduced && <div className="scam-effect__particles" aria-hidden="true">
      {Array.from({ length: lost ? 6 : 10 }, (_, i) => <img key={i} alt="" className="scam-effect__piece"
        src={lost ? new URL('./assets/smoke.svg', import.meta.url).href : notes[i % notes.length]}
        style={{ '--x': `${5 + i * (lost ? 16 : 10)}%`, '--delay': `${i % 4 * 55}ms`, '--drift': `${(i % 3 - 1) * 65}px`, '--turn': `${(i % 2 ? 1 : -1) * (100 + i * 23)}deg` } as CSSProperties} />)}
      {lost && <svg className="scam-effect__crack" viewBox="0 0 300 120"><path d="M10 15 95 40 80 55 155 60 135 83 285 105M155 60 195 15M135 83 110 115" /></svg>}
    </div>}
    <div className="scam-effect__label" role="status">
      <strong>{lost ? 'Ngắt liên lạc' : `+${reward.amount}$`}</strong>
      {reward.kind === 'won' && <span>Thắng trọn ván · May mắn +{reward.bonus}$</span>}
      {lost && <span>Tiền đã đạt vẫn được giữ</span>}
    </div>
  </div>;
}
