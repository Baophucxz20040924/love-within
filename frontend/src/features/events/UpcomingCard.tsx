import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import type { PulseNextEvent } from '../../lib/types';
import { daysLeftText, eventDayText } from './constants';
import { CountdownCells, useNow } from './Countdown';

/**
 * Home card "Sắp tới" (CP4): the nearest event in the next 30 days, from the polled pulse (no request of its own).
 * "Gặp nhau" with a time counts down days · hours · minutes, ticking on the phone from the server's startsAt.
 */
export function UpcomingCard({ event }: { event: PulseNextEvent }) {
  const live = event.kind === 'meet' && event.startsAt !== null;
  const now = useNow(1000, live);
  const msLeft = live ? new Date(event.startsAt!).getTime() - now : 0;
  const counting = live && msLeft > 0;
  const today = event.daysLeft === 0;
  const when = today ? (event.time ? `Hôm nay lúc ${event.time}` : eventDayText(event.date)) : `${eventDayText(event.date)}${event.time ? ` · ${event.time}` : ''}`;

  return (
    <Link to="/events" className="card card--link ev-card">
      <div className="row">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="calendar" />
        </span>
        <div className="grow">
          <p className="card__title">Sắp tới</p>
          <p className="text-sm text-muted">{when}</p>
        </div>
        <Icon name="chevronRight" className="text-muted" />
      </div>

      {today ? (
        <p className="ev-card__line ev-card__line--today">🎉 Hôm nay: {event.title}</p>
      ) : (
        <p className="ev-card__line">
          <span aria-hidden="true">{event.emoji}</span> {event.title}
          {!counting && <span className="ev-card__left"> · {daysLeftText(event.daysLeft)}</span>}
        </p>
      )}
      {counting && <CountdownCells ms={msLeft} />}
      {event.others > 0 && <p className="text-sm text-muted">và {event.others} sự kiện khác</p>}
    </Link>
  );
}
