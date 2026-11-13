import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import type { PulseLetters } from '../../lib/types';
import { useCouplePeople } from '../questions/useCouplePeople';
import { Envelope } from './Envelope';

/**
 * Home card "💌 Có thư từ Hà mở được hôm nay" (CP2), from the polled pulse (no request of its own). Shown only while
 * letters to me can be opened and are not opened yet. Web Push (N4) also tells the recipient (job letters.ready).
 */
export function LettersCard({ letters }: { letters: PulseLetters }) {
  const { partnerName } = useCouplePeople();
  const one = letters.openable === 1 && letters.openableId;
  const to = one ? `/letters/${letters.openableId}` : '/letters';
  const text = letters.openable === 1 ? `Có thư từ ${partnerName} mở được hôm nay` : `Có ${letters.openable} lá thư từ ${partnerName} mở được hôm nay`;
  return (
    <Link to={to} className="card card--link letter-card">
      <Envelope state="ready" small />
      <span className="letter-card__body">
        <span className="letter-card__title">💌 {text}</span>
        <span className="letter-card__hint">Chạm để mở phong bì</span>
      </span>
      <Icon name="chevronRight" className="text-muted" />
    </Link>
  );
}
