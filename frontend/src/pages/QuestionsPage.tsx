import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { questionHistoryKey, questionsApi, stateOf, type QuestionFilter } from '../features/questions/api';
import { questionLabel, useCouplePeople } from '../features/questions/useCouplePeople';
import { dayHeading } from '../lib/format';
import type { DailyQuestion } from '../lib/types';

function StatusChip({ q, partnerName }: { q: DailyQuestion; partnerName: string }) {
  switch (stateOf(q)) {
    case 'both':
      return <span className="chip chip--success">Hai bạn đã trả lời</span>;
    case 'mine_answered':
      return <span className="chip">Đang chờ {partnerName}</span>;
    case 'partner_answered':
      return <span className="chip chip--brand">{partnerName} đã trả lời 🔒</span>;
    default:
      return <span className="chip chip--warning">Chưa trả lời</span>;
  }
}

const FILTERS: { value: QuestionFilter; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'unanswered', label: 'Chưa trả lời' },
];

/** /questions — every day's question, newest first. Earlier days can still be answered. */
export function QuestionsPage() {
  const { myId, partnerName, today } = useCouplePeople();
  const [filter, setFilter] = useState<QuestionFilter>('all');
  const sentinel = useRef<HTMLDivElement>(null);

  const feed = useInfiniteQuery({
    queryKey: questionHistoryKey(filter),
    queryFn: ({ pageParam }) => questionsApi.list(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
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

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Page title="Câu hỏi mỗi ngày" subtitle="Mỗi ngày một câu để hiểu nhau hơn" back="/">
      <SegmentedControl mode="group" ariaLabel="Lọc câu hỏi" value={filter} options={FILTERS} onChange={setFilter} />

      {feed.isLoading && <Skeleton height={88} count={4} />}
      {feed.isError && <ErrorState onRetry={() => void feed.refetch()} />}
      {feed.isSuccess && items.length === 0 && (
        <div className="card">
          {filter === 'unanswered' ? (
            <EmptyState art="🎉" title="Bạn đã trả lời hết rồi" hint="Câu hỏi mới mỗi ngày sẽ hiện ở Trang chủ." />
          ) : (
            <EmptyState art="💬" title="Chưa có câu hỏi nào" hint="Câu hỏi đầu tiên sẽ hiện ở Trang chủ." />
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="list">
          {items.map((q) => {
            const label = questionLabel(q, myId, partnerName);
            return (
              <Link key={q.id} to={`/questions/${q.id}`} className="list__item q-row">
                <span className="list__body">
                  <span className="q-row__meta">
                    {dayHeading(q.localDate, today)}
                    {label ? ` · ${label}` : ''}
                  </span>
                  <span className="q-row__text">{q.text}</span>
                  <StatusChip q={q} partnerName={partnerName} />
                </span>
                <Icon name="chevronRight" className="text-muted" />
              </Link>
            );
          })}
        </div>
      )}
      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <Skeleton height={88} />}
    </Page>
  );
}
