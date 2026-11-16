import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import type { FriendEvent } from '../../lib/types';
import { friendEventsApi, FRIEND_EVENT_STRIP_KEY } from './api';
import { dateTile, RSVP_LABEL, statusLabel, timeLabel, dayLabel } from './eventFormat';
import { FriendEventSheet } from './FriendEventSheet';

/** Date tile + title + when + who is going: used by the feed strip and the events list. */
export function EventCard({ ev, wide = false }: { ev: FriendEvent; wide?: boolean }) {
  const tile = dateTile(ev.startAt);
  const start = new Date(ev.startAt);
  const answer = ev.isMine ? 'Bạn tạo' : ev.myRsvp ? RSVP_LABEL[ev.myRsvp] : 'Chưa trả lời';
  return (
    <Link to={`/friends/events/${ev.id}`} className={`fev-card${wide ? ' fev-card--wide' : ''}${ev.status === 'cancelled' || ev.past ? ' is-muted' : ''}`}>
      {ev.cover ? (
        <img className="fev-card__cover" src={ev.cover.url} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="fev-card__cover fev-card__cover--blank" aria-hidden="true" />
      )}
      <span className="fev-card__tile" aria-hidden="true">
        <span className="fev-card__day">{tile.day}</span>
        <span className="fev-card__month">{tile.month}</span>
      </span>
      <span className="fev-card__body">
        <span className="fev-card__title">{ev.title}</span>
        <span className="fev-card__when">
          {dayLabel(start)} · {timeLabel(start)}
        </span>
        {ev.place && <span className="fev-card__place">{ev.place}</span>}
        <span className="fev-card__foot">
          <span className="avatar-pair" aria-hidden="true">
            {ev.goingPreview.slice(0, 3).map((u) => (
              <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size={20} ring />
            ))}
          </span>
          <span className="fev-card__going">{ev.counts.going} người đi</span>
        </span>
        <span className="fev-card__chips">
          <span className={`chip${ev.status === 'cancelled' ? ' chip--danger' : ' chip--brand'}`}>{statusLabel(ev)}</span>
          <span className="chip">{answer}</span>
        </span>
      </span>
    </Link>
  );
}

/**
 * "Kèo sắp tới" on the feed (BB5): my events and the ones I am invited to that have not happened yet (cancelled ones are
 * left out here), cards scrolling sideways, "+ Lên kèo" first and "Xem tất cả" → /friends/events.
 */
export function FriendEventStrip() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: FRIEND_EVENT_STRIP_KEY,
    queryFn: () => friendEventsApi.list('upcoming', 3),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const items = (list.data?.items ?? []).filter((e) => e.status === 'active');

  return (
    <section className="section fev-strip" aria-labelledby="fev-strip-title">
      <h2 id="fev-strip-title" className="section__title fev-strip__head">
        <span>Kèo sắp tới</span>
        <Link to="/friends/events" className="btn btn-ghost fev-strip__all">
          Xem tất cả
        </Link>
      </h2>
      {list.isError && (
        <p className="text-sm text-muted suggest__error">
          Không tải được kèo.{' '}
          <button type="button" className="btn btn-ghost" onClick={() => void list.refetch()}>
            Thử lại
          </button>
        </p>
      )}
      <ul className="suggest__list fev-strip__list">
        <li className="fev-strip__new-item">
          <button type="button" className="fev-strip__new" onClick={() => setCreating(true)}>
            <span className="fev-strip__plus" aria-hidden="true">
              <Icon name="plus" size={26} />
            </span>
            <span>Lên kèo</span>
          </button>
        </li>
        {list.isLoading && (
          <li className="fev-strip__loading" aria-busy="true" aria-label="Đang tải">
            <span className="skeleton" />
          </li>
        )}
        {!list.isError && items.map((ev) => (
          <li key={ev.id} className="fev-strip__item">
            <EventCard ev={ev} />
          </li>
        ))}
        {list.isSuccess && items.length === 0 && (
          <li className="fev-strip__empty">
            <span className="text-sm text-muted">Chưa có kèo nào sắp tới. Rủ bạn bè đi đâu đó nhé!</span>
          </li>
        )}
      </ul>
      <FriendEventSheet open={creating} editing={null} onClose={() => setCreating(false)} onSaved={(ev) => navigate(`/friends/events/${ev.id}`)} />
    </section>
  );
}
