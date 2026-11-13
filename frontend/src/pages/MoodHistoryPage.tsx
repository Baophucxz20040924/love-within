import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { moodHistoryKey, moodsApi } from '../features/nudges/api';
import { MOOD_COLORS } from '../features/nudges/constants';
import { MOODS, moodOf } from '../features/stories/constants';
import { dayHeading, formatDay, shortName } from '../lib/format';
import type { MoodView } from '../lib/types';

const DAYS = 30;

/** Every day from `from` to `to` ("YYYY-MM-DD", inclusive), oldest first. */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const dayMonth = (day: string) => formatDay(day).slice(0, 5);

/** One member's 30 days: a cell per day with the mood emoji on its colour (empty = no mood that day). */
function MoodStrip({ name, avatarUrl, days, moods, isMe }: { name: string; avatarUrl: string | null; days: string[]; moods: Map<string, MoodView>; isMe: boolean }) {
  const count = days.filter((d) => moods.has(d)).length;
  const title = isMe ? 'Bạn' : shortName(name);
  return (
    <section className="card mood-member" aria-label={`Cảm xúc ${DAYS} ngày của ${isMe ? 'bạn' : shortName(name)}`}>
      <div className="row">
        <Avatar name={name} src={avatarUrl} size={36} />
        <div className="grow">
          <h2 className="card__title">{title}</h2>
          <p className="text-sm text-muted">
            {count}/{days.length} ngày có cảm xúc
          </p>
        </div>
      </div>
      <ol className="mood-strip">
        {days.map((d, i) => {
          const m = moods.get(d);
          const info = moodOf(m?.mood ?? null);
          const isToday = i === days.length - 1;
          return (
            <li
              key={d}
              className={`mood-cell${info ? '' : ' mood-cell--empty'}${isToday ? ' mood-cell--today' : ''}`}
              style={m ? { background: MOOD_COLORS[m.mood] } : undefined}
              title={`${dayMonth(d)}: ${info ? info.label : 'chưa chọn'}`}
            >
              <span aria-hidden="true">{info?.emoji ?? ''}</span>
              <span className="visually-hidden">
                {isToday ? 'Hôm nay' : dayMonth(d)}: {info ? info.label : 'chưa chọn'}
                {m?.note ? `. Ghi chú: ${m.note}` : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mood-strip__ends" aria-hidden="true">
        <span>{dayMonth(days[0])}</span>
        <span>Hôm nay</span>
      </p>
    </section>
  );
}

/** Hồ sơ → "Cảm xúc 30 ngày" (CP5): both members' moods as coloured day cells, a legend and the notes. */
export function MoodHistoryPage() {
  const { me } = useAuth();
  const history = useQuery({ queryKey: moodHistoryKey(DAYS), queryFn: () => moodsApi.history(DAYS) });
  const myId = me?.user.id ?? '';
  const partner = me?.couple?.members.find((m) => m.id !== myId) ?? null;

  let body;
  if (history.isLoading) body = <Skeleton height={150} count={2} />;
  else if (history.isError || !history.data) body = <ErrorState onRetry={() => void history.refetch()} />;
  else if (history.data.items.length === 0) {
    body = (
      <div className="card">
        <EmptyState
          art="🌤️"
          title="Chưa có cảm xúc nào"
          hint="Chạm vào ô “Bạn” trong khối trên cùng ở Trang chủ để chọn cảm xúc hôm nay."
          action={
            <Link to="/" className="btn btn-primary">
              Về Trang chủ
            </Link>
          }
        />
      </div>
    );
  } else {
    const h = history.data;
    const days = dayRange(h.from, h.to);
    const byUser = (id: string) => new Map(h.items.filter((x) => x.userId === id).map((x) => [x.localDate, x]));
    const nameOf = (id: string) => (id === myId ? 'Bạn' : partner ? shortName(partner.displayName) : 'Người ấy');
    const notes = h.items.filter((x) => x.note).reverse();
    body = (
      <>
        <MoodStrip name={me?.user.displayName ?? ''} avatarUrl={me?.user.avatarUrl ?? null} days={days} moods={byUser(myId)} isMe />
        {partner && <MoodStrip name={partner.displayName} avatarUrl={partner.avatarUrl} days={days} moods={byUser(partner.id)} isMe={false} />}

        <section className="card" aria-labelledby="mood-legend-title">
          <h2 id="mood-legend-title" className="card__title">
            Chú thích
          </h2>
          <ul className="mood-legend">
            {MOODS.map((m) => (
              <li key={m.key}>
                <span className="mood-cell" style={{ background: MOOD_COLORS[m.key] }} aria-hidden="true">
                  {m.emoji}
                </span>
                {m.label}
              </li>
            ))}
            <li>
              <span className="mood-cell mood-cell--empty" aria-hidden="true" />
              chưa chọn
            </li>
          </ul>
        </section>

        {notes.length > 0 && (
          <div className="section">
            <h2 className="section__title">Ghi chú</h2>
            <div className="list">
              {notes.map((x) => {
                const m = moodOf(x.mood);
                return (
                  <div key={`${x.userId}-${x.localDate}`} className="list__item">
                    <span className="mood-cell" style={{ background: MOOD_COLORS[x.mood] }} aria-hidden="true">
                      {m?.emoji}
                    </span>
                    <span className="list__body">
                      <span className="list__label">“{x.note}”</span>
                      <span className="list__meta" style={{ display: 'block' }}>
                        {nameOf(x.userId)} · {m?.label} · {dayHeading(x.localDate, h.to)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <Page title={`Cảm xúc ${DAYS} ngày`} back="/profile">
      <p className="text-sm text-muted">Mỗi ô là một ngày, mới nhất ở cuối. Chọn cảm xúc hôm nay ở khối trên cùng của Trang chủ.</p>
      {body}
    </Page>
  );
}
