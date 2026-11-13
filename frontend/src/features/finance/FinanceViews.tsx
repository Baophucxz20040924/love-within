import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../../components/StatusViews';
import { dayHeading, formatNetVnd, formatNumber, formatSignedVnd, formatTime, formatVnd, monthLabel, shiftMonth } from '../../lib/format';
import type { BankTxn, FinanceSummary } from '../../lib/types';
import { financeApi, financeTxnsKey, type FinanceOwner } from './api';

/** ‹ Tháng 11/2026 › — cannot go past the current month. */
export function MonthNav({ month, max, onChange }: { month: string; max: string; onChange: (m: string) => void }) {
  return (
    <div className="month-nav">
      <button type="button" className="icon-btn" aria-label="Tháng trước" onClick={() => onChange(shiftMonth(month, -1))}>
        <Icon name="chevronLeft" />
      </button>
      <span className="month-nav__label" aria-live="polite">
        {monthLabel(month)}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Tháng sau"
        disabled={month >= max}
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}

/** Tiền vào / Tiền ra side by side, Chênh lệch on its own row (long amounts never wrap on a 360 px phone). */
export function SummaryCard({ summary }: { summary: FinanceSummary }) {
  return (
    <div className="card">
      <div className="fin-summary">
        <div className="fin-summary__item">
          <span className="fin-summary__label">Tiền vào</span>
          <span className="fin-summary__value money-in">+{formatVnd(summary.totalIn)}</span>
        </div>
        <div className="fin-summary__item">
          <span className="fin-summary__label">Tiền ra</span>
          <span className="fin-summary__value money-out">−{formatVnd(summary.totalOut)}</span>
        </div>
      </div>
      <div className="fin-summary__net">
        <span className="text-sm text-muted">
          Chênh lệch · {formatNumber(summary.count)} giao dịch
        </span>
        <span className={`fin-summary__value${summary.net > 0 ? ' money-in' : summary.net < 0 ? ' money-out' : ''}`}>
          {formatNetVnd(summary.net)}
        </span>
      </div>
    </div>
  );
}

function TxnRow({ t, onSelect }: { t: BankTxn; onSelect?: (t: BankTxn) => void }) {
  const isIn = t.direction === 'in';
  const kind = isIn ? 'Tiền vào' : 'Tiền ra';
  const content = (
    <>
      <span className={`icon-tile ${isIn ? 'icon-tile--success' : 'icon-tile--neutral'}`} aria-hidden="true">
        <Icon name={isIn ? 'arrowDownLeft' : 'arrowUpRight'} size={20} />
      </span>
      <span className="list__body">
        <span className="list__label txn__note">{t.note || kind}</span>
        <span className="list__meta txn__meta">
          {t.note ? `${kind} · ` : ''}
          {formatTime(t.occurredAt)}
          {onSelect && !t.note ? ' · Thêm ghi chú' : ''}
        </span>
      </span>
      <span className={`txn__amount ${isIn ? 'money-in' : 'money-out'}`}>{formatSignedVnd(t.direction, t.amount)}</span>
    </>
  );
  if (!onSelect) return <div className="list__item">{content}</div>;
  return (
    <button type="button" className="list__item" onClick={() => onSelect(t)} aria-label={`${kind} ${formatVnd(t.amount)}, sửa ghi chú${t.isMine && !isIn ? ' hoặc góp quỹ' : ''}`}>
      {content}
    </button>
  );
}

interface FeedProps {
  owner: FinanceOwner;
  month: string;
  /** "YYYY-MM-DD" today in the viewer's timezone (for "Hôm nay" / "Hôm qua"). */
  today: string;
  /** Mine only: open the note sheet. */
  onSelect?: (t: BankTxn) => void;
  emptyHint: string;
}

/** Transactions of one month grouped by day, newest first, infinite scroll. Polls every 60 s while open. */
export function TxnFeed({ owner, month, today, onSelect, emptyHint }: FeedProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const feed = useInfiniteQuery({
    queryKey: financeTxnsKey(owner, month),
    queryFn: ({ pageParam }) => financeApi.transactions(owner, month, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (feed.isLoading) return <Skeleton height={56} count={4} />;
  if (feed.isError) return <ErrorState onRetry={() => void feed.refetch()} />;

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return (
      <div className="card">
        <EmptyState art="🧾" title={`Chưa có giao dịch trong ${monthLabel(month).toLocaleLowerCase('vi')}`} hint={emptyHint} />
      </div>
    );
  }

  const days: { day: string; txns: BankTxn[] }[] = [];
  for (const t of items) {
    const last = days[days.length - 1];
    if (last && last.day === t.localDate) last.txns.push(t);
    else days.push({ day: t.localDate, txns: [t] });
  }

  return (
    <div className="stack">
      {days.map((d) => (
        <section key={d.day} className="stack" aria-label={dayHeading(d.day, today)}>
          <h3 className="day-heading">{dayHeading(d.day, today)}</h3>
          <div className="list">
            {d.txns.map((t) => (
              <TxnRow key={t.id} t={t} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <Skeleton height={56} count={2} />}
    </div>
  );
}
