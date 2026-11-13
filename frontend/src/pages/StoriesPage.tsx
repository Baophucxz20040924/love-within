import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { STORY_FEED_KEY, STORY_OTD_KEY, STORY_UNREAD_KEY, storiesApi } from '../features/stories/api';
import { StoryCard } from '../features/stories/StoryCard';
import { StoryComposer } from '../features/stories/StoryComposer';
import { formatDay, shortName } from '../lib/format';
import type { Story, StoryUnread } from '../lib/types';

function OnThisDay({ items }: { items: Story[] }) {
  const year = new Date().getFullYear();
  return (
    <section className="card otd" aria-label="Ngày này năm xưa">
      <p className="otd__title">
        <Icon name="clock" size={16} /> Ngày này năm xưa
      </p>
      {items.map((s) => (
        <Link key={s.id} to={`/stories/${s.id}`} className="otd__item">
          {s.photos[0] ? (
            <img className="otd__thumb" src={s.photos[0].url} alt="" loading="lazy" />
          ) : (
            <span className="otd__thumb otd__thumb--text" aria-hidden="true">
              💞
            </span>
          )}
          <span className="otd__body">
            <span className="otd__when">
              {year - Number(s.happenedOn.slice(0, 4))} năm trước · {formatDay(s.happenedOn)}
            </span>
            <span className="otd__excerpt">{s.body || 'Một kỷ niệm bằng ảnh'}</span>
          </span>
          <Icon name="chevronRight" className="text-muted" />
        </Link>
      ))}
    </section>
  );
}

type ComposerState = { open: boolean; editing: Story | null; files: File[] };
const CLOSED: ComposerState = { open: false, editing: null, files: [] };

export function StoriesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { me } = useAuth();
  const name = me?.user.displayName ?? '';
  const [composer, setComposer] = useState<ComposerState>(CLOSED);
  const [params, setParams] = useSearchParams();
  // Reuse the normal composer and its own saved draft; never prefill over that draft.
  useEffect(() => {
    if (params.get('compose') !== '1') return;
    setComposer((current) => current.open ? current : { open: true, editing: null, files: [] });
    setParams((current) => { const next = new URLSearchParams(current); next.delete('compose'); return next; }, { replace: true });
  }, [params, setParams]);
  const fileRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const feed = useInfiniteQuery({
    queryKey: STORY_FEED_KEY,
    queryFn: ({ pageParam }) => storiesApi.feed(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const otd = useQuery({ queryKey: STORY_OTD_KEY, queryFn: storiesApi.onThisDay, staleTime: 5 * 60_000 });

  // Mark the feed as seen once on entry (keeping the previous time as the "Mới" baseline),
  // and again whenever fresh posts are loaded while the page stays open.
  const [baseline, setBaseline] = useState<string | null | undefined>(undefined);
  const markedAt = useRef(0);
  useEffect(() => {
    const at = feed.dataUpdatedAt;
    if (!at || at <= markedAt.current) return;
    if (markedAt.current !== 0 && baseline === undefined) return; // first mark still in flight
    const first = markedAt.current === 0;
    markedAt.current = at;
    storiesApi
      .seen()
      .then((r) => first && setBaseline(r.previousSeenAt))
      .catch(() => first && setBaseline(null))
      .finally(() => {
        qc.setQueryData<StoryUnread>(STORY_UNREAD_KEY, { count: 0, stories: 0, comments: 0 });
      });
  }, [feed.dataUpdatedAt, baseline, qc]);

  // Infinite scroll.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const isNew = (s: Story) => !s.isMine && baseline !== undefined && (baseline === null || s.createdAt > baseline);

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) setComposer({ open: true, editing: null, files });
  }
  const write = () => setComposer({ open: true, editing: null, files: [] });

  return (
    <Page
      title="Story"
      subtitle="Nhật ký riêng của hai bạn"
      actions={
        <>
          <Link to="/moments" className="icon-btn" aria-label="Khoảnh khắc đôi" title="Khoảnh khắc đôi">
            <Icon name="camera" />
          </Link>
          <Link to="/letters" className="icon-btn" aria-label="Thư hẹn giờ" title="Thư hẹn giờ">
            <Icon name="mail" />
          </Link>
        </>
      }
    >
      <div className="card composer-prompt">
        <Avatar name={name} src={me?.user.avatarUrl} size={40} />
        <button type="button" className="composer-prompt__input" onClick={write}>
          {shortName(name)} ơi, bạn đang nghĩ gì?
        </button>
        <button type="button" className="icon-btn composer-prompt__photo" aria-label="Đăng ảnh" onClick={() => fileRef.current?.click()}>
          <Icon name="image" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      </div>

      {otd.data && otd.data.length > 0 && <OnThisDay items={otd.data} />}

      {feed.isLoading && <Skeleton height={280} count={2} />}
      {feed.isError && <ErrorState onRetry={() => void feed.refetch()} />}
      {feed.isSuccess && items.length === 0 && (
        <div className="card">
          <EmptyState
            art="📖"
            title="Chưa có bài viết nào"
            hint="Viết kỷ niệm đầu tiên của hai bạn — ngày hai bạn gặp nhau chẳng hạn?"
            action={
              <button type="button" className="btn btn-primary" onClick={write}>
                <Icon name="edit" size={18} /> Viết bài đầu tiên
              </button>
            }
          />
        </div>
      )}

      {items.map((s) => (
        <StoryCard
          key={s.id}
          story={s}
          isNew={isNew(s)}
          onEdit={(st) => setComposer({ open: true, editing: st, files: [] })}
          onComment={() => navigate(`/stories/${s.id}`)}
        />
      ))}

      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <Skeleton height={220} />}
      {feed.isSuccess && !hasNextPage && items.length > 3 && <p className="feed-end">Bạn đã xem hết kỷ niệm 💞</p>}

      <StoryComposer open={composer.open} editing={composer.editing} initialFiles={composer.files} onClose={() => setComposer(CLOSED)} />
    </Page>
  );
}
