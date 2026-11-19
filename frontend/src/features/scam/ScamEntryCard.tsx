import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import './scam-entry.css';

/** Discovery only: keep game state and requests in the lazy game route. */
export function ScamEntryCard() {
  return <Link to="/friends/scam" className="scam-entry">
    <span className="scam-entry__art" aria-hidden="true">🕶️</span>
    <span className="scam-entry__body">
      <span className="scam-entry__eyebrow">Góc giải trí · Solo AI</span>
      <strong>Scam with Famous People</strong>
      <span className="scam-entry__description">Chat với nhân vật AI · Thử thách 3 bước</span>
      <span className="scam-entry__cta">Chơi ngay <Icon name="chevronRight" size={16} /></span>
    </span>
    <span className="scam-entry__decoration" aria-hidden="true">💬</span>
  </Link>;
}
