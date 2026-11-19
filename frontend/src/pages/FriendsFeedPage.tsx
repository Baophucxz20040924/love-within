import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { FRIEND_FEED_KEY, FRIENDS_OVERVIEW_KEY, friendStoriesApi, friendsApi } from '../features/friends/api';
import { FriendComposer } from '../features/friends/FriendComposer';
import { POST_MEDIA_ACCEPT } from '../features/stories/postMedia';
import { FriendEventStrip } from '../features/friends/FriendEventStrip';
import { ScamEntryCard } from '../features/scam/ScamEntryCard';
import { FriendStoryCard } from '../features/friends/FriendStoryCard';
import { FriendSuggestions } from '../features/friends/FriendSuggestions';
import { shortName } from '../lib/format';
import type { FriendStory } from '../lib/types';

type ComposerState = { open: boolean; editing: FriendStory | null; files: File[] };
const CLOSED: ComposerState = { open: false, editing: null, files: [] };

/** /friends — news feed of the hidden friends space: my posts + my friends' posts. */
export function FriendsFeedPage() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const name = me?.user.displayName ?? '';
  const [composer, setComposer] = useState<ComposerState>(CLOSED);
  const fileRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const feed = useInfiniteQuery({
    queryKey: FRIEND_FEED_KEY,
    queryFn: ({ pageParam, signal }) => friendStoriesApi.feed(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const overview = useQuery({ queryKey: FRIENDS_OVERVIEW_KEY, queryFn: friendsApi.overview });
  const friendCount = overview.data?.friends.length ?? 0;

  // Infinite scroll.
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchNextPageError) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) setComposer({ open: true, editing: null, files });
  }
  const write = () => setComposer({ open: true, editing: null, files: [] });

  return (
    <Page
      className="friends-feed"
      title="Bảng tin"
      subtitle="Hội bạn bè"
      bell={false}
      actions={
        <Link to="/friends/people" className="icon-btn" aria-label="Tìm bạn bè">
          <Icon name="search" />
        </Link>
      }
    >
      <section className="card feed-compose" aria-label="Chia sẻ với bạn bè">
        <p className="feed-compose__heading">Một chút chuyện hôm nay</p>
        <div className="composer-prompt">
          <Avatar name={name} src={me?.user.avatarUrl} size={40} />
          <button type="button" className="composer-prompt__input" onClick={write}>
            {shortName(name)} ơi, bạn đang nghĩ gì?
          </button>
          <button type="button" className="icon-btn composer-prompt__photo" aria-label="Đăng ảnh hoặc video" onClick={() => fileRef.current?.click()}>
            <Icon name="image" />
          </button>
          <input ref={fileRef} type="file" accept={POST_MEDIA_ACCEPT} multiple hidden onChange={onFiles} />
        </div>
      </section>

      <ScamEntryCard />
      {/* BB5: before the posts; independent of game discovery. */}
      <FriendEventStrip />

      {overview.isSuccess && friendCount === 0 && items.length > 0 && (
        <div className="list">
          <Link to="/friends/people" className="list__item">
            <span className="icon-tile" aria-hidden="true">
              <Icon name="userPlus" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label" style={{ display: 'block' }}>
                Tìm bạn bè
              </span>
              <span className="list__meta">Kết bạn để xem bài viết của mọi người ở đây.</span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
        </div>
      )}

      {feed.isLoading && <Skeleton height={280} count={2} />}
      {feed.isError && !feed.isFetchNextPageError && <ErrorState onRetry={() => void feed.refetch()} />}
      {feed.isSuccess && items.length === 0 && (
        <>
          <div className="card">
            <EmptyState
              art="👋"
              title="Bảng tin còn trống"
              hint={friendCount === 0 ? 'Kết bạn với mọi người để xem bài viết của họ, hoặc đăng bài đầu tiên của bạn.' : 'Chưa ai đăng gì. Mở màn bằng một bài viết nhé!'}
              action={
                <div className="btn-row">
                  {friendCount === 0 && (
                    <Link to="/friends/people" className="btn btn-outline">
                      <Icon name="userPlus" size={18} /> Tìm bạn bè
                    </Link>
                  )}
                  <button type="button" className="btn btn-primary" onClick={write}>
                    <Icon name="edit" size={18} /> Viết bài
                  </button>
                </div>
              }
            />
          </div>
          {/* BB7: an empty feed also suggests people (friends of my friends; nothing when I have no friend yet). */}
          {friendCount > 0 && <FriendSuggestions />}
        </>
      )}

      {items.map((s) => (
        <FriendStoryCard
          key={s.id}
          story={s}
          onEdit={(st) => setComposer({ open: true, editing: st, files: [] })}
          onComment={() => navigate(`/friends/posts/${s.id}`)}
        />
      ))}

      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <Skeleton height={220} />}
      {feed.isFetchNextPageError && (
        <div className="card">
          <ErrorState title="Chưa tải được bài viết tiếp theo" onRetry={() => void fetchNextPage()} />
        </div>
      )}
      {feed.isSuccess && !hasNextPage && items.length > 3 && <p className="feed-end">Bạn đã xem hết bài viết</p>}

      <FriendComposer open={composer.open} editing={composer.editing} initialFiles={composer.files} onClose={() => setComposer(CLOSED)} />
    </Page>
  );
}
