import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { EVENTS_KEY, eventsApi } from '../features/events/api';
import { daysLeftText, eventDayText } from '../features/events/constants';
import { DeleteEventSheet, EventDetailSheet, EventFormSheet } from '../features/events/EventSheets';
import { LetterComposer } from '../features/letters/LetterComposer';
import { formatNumber } from '../lib/format';
import type { CoupleEvent } from '../lib/types';

function DaysBadge({ ev }: { ev: CoupleEvent }) {
  if (ev.daysLeft === 0) return <span className="chip chip--brand">Hôm nay</span>;
  if (ev.daysLeft === 1) return <span className="chip chip--brand">Ngày mai</span>;
  if (ev.daysLeft < 0) return <span className="ev-row__ago">{daysLeftText(ev.daysLeft)}</span>;
  return (
    <span className="ev-row__count" aria-label={`còn ${ev.daysLeft} ngày`}>
      <span className="ev-row__num">{formatNumber(ev.daysLeft)}</span>
      <span className="ev-row__unit">ngày</span>
    </span>
  );
}

function EventRow({ ev, onOpen }: { ev: CoupleEvent; onOpen: (ev: CoupleEvent) => void }) {
  return (
    <button type="button" className={`list__item ev-row${ev.daysLeft < 0 ? ' ev-row--past' : ''}`} onClick={() => onOpen(ev)}>
      <span className="ev-row__emoji" aria-hidden="true">
        {ev.emoji}
      </span>
      <span className="list__body ev-row__body">
        <span className="list__label ev-row__title">{ev.title}</span>
        <span className="list__meta">
          {eventDayText(ev.nextDate)}
          {ev.time ? ` · ${ev.time}` : ''}
        </span>
        {(ev.auto || ev.repeat === 'yearly') && (
          <span className="ev-row__tags">
            {ev.auto ? <span className="chip">Mốc tự động</span> : <span className="chip">Hằng năm</span>}
          </span>
        )}
      </span>
      <DaysBadge ev={ev} />
    </button>
  );
}

/** /events — countdowns (CP4): upcoming (with auto milestones from the anniversary date) and past one-off events. */
export function EventsPage() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: EVENTS_KEY, queryFn: eventsApi.list, staleTime: 0, refetchOnWindowFocus: true });
  const [form, setForm] = useState<{ open: boolean; editing: CoupleEvent | null }>({ open: false, editing: null });
  const [detail, setDetail] = useState<CoupleEvent | null>(null);
  const [deleting, setDeleting] = useState<CoupleEvent | null>(null);
  /** CP2: "Viết thư mở vào ngày này" → letter composer with that open date. */
  const [letterOn, setLetterOn] = useState<string | null>(null);

  // Opened from Home or Hồ sơ: go back there; a direct link falls back to Home.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/', { replace: true });
  };

  const upcoming = list.data?.upcoming ?? [];
  const past = list.data?.past ?? [];
  const ownCount = upcoming.filter((e) => !e.auto).length + past.length;

  return (
    <Page title="Sự kiện" subtitle="Đếm ngược tới những ngày quan trọng" onBack={goBack}>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setForm({ open: true, editing: null })}>
        <Icon name="plus" size={20} /> Thêm sự kiện
      </button>

      {list.isLoading && <Skeleton height={72} count={4} />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}

      {list.isSuccess && (
        <>
          <div className="section">
            <h2 className="section__title">Sắp tới</h2>
            {upcoming.length > 0 ? (
              <div className="list">
                {upcoming.map((ev) => (
                  <EventRow key={ev.id} ev={ev} onOpen={setDetail} />
                ))}
              </div>
            ) : (
              <div className="card">
                <EmptyState
                  art="📅"
                  title="Chưa có sự kiện nào"
                  hint="Thêm sinh nhật, chuyến đi hay ngày gặp nhau để cùng đếm ngược."
                />
              </div>
            )}
            {ownCount === 0 && upcoming.length > 0 && (
              <p className="field__hint">Các mốc tự động tính từ ngày bắt đầu yêu. Thêm sinh nhật hay chuyến đi để cùng đếm ngược.</p>
            )}
          </div>

          {past.length > 0 && (
            <div className="section">
              <h2 className="section__title">Đã qua</h2>
              <div className="list">
                {past.map((ev) => (
                  <EventRow key={ev.id} ev={ev} onOpen={setDetail} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <EventDetailSheet
        event={detail}
        onClose={() => setDetail(null)}
        onEdit={(ev) => {
          setDetail(null);
          setForm({ open: true, editing: ev });
        }}
        onDelete={(ev) => {
          setDetail(null);
          setDeleting(ev);
        }}
        onWriteLetter={(openOn) => {
          setDetail(null);
          setLetterOn(openOn);
        }}
      />
      <EventFormSheet open={form.open} editing={form.editing} onClose={() => setForm({ open: false, editing: null })} />
      <DeleteEventSheet event={deleting} onClose={() => setDeleting(null)} />
      <LetterComposer open={letterOn !== null} editing={null} initialOpenOn={letterOn} onClose={() => setLetterOn(null)} />
    </Page>
  );
}
