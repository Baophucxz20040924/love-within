import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { LETTER_LIST_KEY, lettersApi } from '../features/letters/api';
import { Envelope } from '../features/letters/Envelope';
import { openedWhen, sealedLeft } from '../features/letters/labels';
import { LetterComposer } from '../features/letters/LetterComposer';
import { useCouplePeople } from '../features/questions/useCouplePeople';
import { formatDate, formatDay, shortName } from '../lib/format';
import type { LetterSummary } from '../lib/types';

function InboxRow({ l }: { l: LetterSummary }) {
  const from = shortName(l.from.displayName);
  const ready = l.openable && !l.openedAt;
  const label = l.openable ? l.title || `Thư từ ${from}` : `Thư từ ${from}`;
  const meta = l.openedAt
    ? `Thư từ ${from} · bạn đã mở ${formatDate(l.openedAt)}`
    : ready
      ? `Thư từ ${from} · mở được từ ${l.daysLeft === 0 ? 'hôm nay' : formatDay(l.openOn)}`
      : `Mở vào ${formatDay(l.openOn)} · ${sealedLeft(l.daysLeft)}`;
  return (
    <Link to={`/letters/${l.id}`} className={`list__item letter-row${ready ? ' letter-row--ready' : ''}`}>
      <Envelope state={l.openable ? 'ready' : 'sealed'} small />
      <span className="list__body letter-row__body">
        <span className="list__label letter-row__title">{label}</span>
        <span className="list__meta">{meta}</span>
      </span>
      {ready ? <span className="chip chip--brand">Mở được rồi</span> : <Icon name="chevronRight" className="text-muted" />}
    </Link>
  );
}

function SentRow({ l }: { l: LetterSummary }) {
  const to = shortName(l.to.displayName);
  const meta = l.openedAt
    ? `${to} đã mở lúc ${openedWhen(l.openedAt)}`
    : l.openable
      ? `Đã tới ngày mở · ${to} chưa mở`
      : `Mở vào ${formatDay(l.openOn)} · ${sealedLeft(l.daysLeft)}`;
  return (
    <Link to={`/letters/${l.id}`} className="list__item letter-row">
      <Envelope state={l.openedAt ? 'ready' : 'sealed'} small />
      <span className="list__body letter-row__body">
        <span className="list__label letter-row__title">{l.title || 'Thư không tiêu đề'}</span>
        <span className="list__meta">{meta}</span>
      </span>
      {l.openedAt ? <span className="chip chip--success">Đã mở</span> : <Icon name="chevronRight" className="text-muted" />}
    </Link>
  );
}

/** /letters — "Thư hẹn giờ" (CP2): letters to me (envelopes until their day) and letters I sent. */
export function LettersPage() {
  const navigate = useNavigate();
  const { partnerName } = useCouplePeople();
  const list = useQuery({ queryKey: LETTER_LIST_KEY, queryFn: lettersApi.list, staleTime: 0, refetchOnWindowFocus: true });
  const [composing, setComposing] = useState(false);

  // Opened from Story (or Home): go back there; a direct link falls back to Story.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/stories', { replace: true });
  };

  const inbox = list.data?.inbox ?? [];
  const sent = list.data?.sent ?? [];

  return (
    <Page title="Thư hẹn giờ" subtitle="Chỉ mở được vào ngày đã hẹn" onBack={goBack}>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setComposing(true)}>
        <Icon name="edit" size={20} /> Viết thư cho {partnerName}
      </button>

      {list.isLoading && <Skeleton height={72} count={3} />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}

      {list.isSuccess && (
        <>
          <div className="section">
            <h2 className="section__title">Thư cho bạn</h2>
            {inbox.length > 0 ? (
              <div className="list">
                {inbox.map((l) => (
                  <InboxRow key={l.id} l={l} />
                ))}
              </div>
            ) : (
              <div className="card">
                <EmptyState
                  art="📭"
                  title="Chưa có thư nào cho bạn"
                  hint={`Khi ${partnerName} viết thư cho bạn, phong bì sẽ nằm ở đây cho tới ngày mở.`}
                />
              </div>
            )}
          </div>

          <div className="section">
            <h2 className="section__title">Thư bạn đã gửi</h2>
            {sent.length > 0 ? (
              <div className="list">
                {sent.map((l) => (
                  <SentRow key={l.id} l={l} />
                ))}
              </div>
            ) : (
              <div className="card">
                <EmptyState
                  art="✉️"
                  title="Bạn chưa gửi thư nào"
                  hint={`Viết cho ${partnerName} một lá thư để mở vào sinh nhật, ngày kỷ niệm hay một năm nữa.`}
                />
              </div>
            )}
          </div>
        </>
      )}

      <LetterComposer open={composing} editing={null} onClose={() => setComposing(false)} />
    </Page>
  );
}
