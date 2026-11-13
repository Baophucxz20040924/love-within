import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import {
  friendProfileKey,
  friendUserFriendsKey,
  friendUserStoriesKey,
  friendsApi,
} from '../features/friends/api';
import { FriendComposer } from '../features/friends/FriendComposer';
import { FriendStoryCard } from '../features/friends/FriendStoryCard';
import { BlockSheet, ReportSheet, type ReportTargetInfo } from '../features/friends/SafetySheets';
import { useGoBack } from '../features/friends/useGoBack';
import { FRIENDS_PUSH_TEXT } from '../features/friends/pushCopy';
import { PushSuggestCard } from '../features/push/PushSuggestCard';
import { pushSuggest } from '../features/push/suggest';
import { ApiRequestError } from '../lib/apiClient';
import { shortName } from '../lib/format';
import type { FriendProfile, FriendStory } from '../lib/types';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

type Tab = 'posts' | 'friends';

function MutualLine({ p }: { p: FriendProfile }) {
  const { count, preview } = p.mutual;
  if (p.relation === 'self' || count === 0) return null;
  const first = preview[0];
  const text = count === 1 ? `1 bạn chung: ${first?.displayName ?? ''}` : `${first?.displayName ?? ''} và ${count - 1} bạn chung khác`;
  return (
    <div className="mutual">
      <span className="avatar-pair" aria-hidden="true">
        {preview.map((u) => (
          <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size={24} ring />
        ))}
      </span>
      <span className="text-sm text-muted">{text}</span>
    </div>
  );
}

/** /friends/u/:userId — someone's profile in the friends space (posts and friends only for friends). */
export function FriendProfilePage() {
  const { userId = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const goBack = useGoBack('/friends');
  const [tab, setTab] = useState<Tab>('posts');
  const [editing, setEditing] = useState<FriendStory | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUnfriend, setConfirmUnfriend] = useState(false);
  const [reporting, setReporting] = useState<ReportTargetInfo | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; displayName: string } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setTab('posts'), [userId]);

  const profile = useQuery({
    queryKey: friendProfileKey(userId),
    queryFn: () => friendsApi.profile(userId),
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 1,
  });
  const p = profile.data;
  const canSee = Boolean(p?.canSeePosts);

  const stories = useInfiniteQuery({
    queryKey: friendUserStoriesKey(userId),
    queryFn: ({ pageParam }) => friendsApi.userStories(userId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: canSee && tab === 'posts',
  });
  const friends = useInfiniteQuery({
    queryKey: friendUserFriendsKey(userId),
    queryFn: ({ pageParam }) => friendsApi.userFriends(userId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: canSee && tab === 'friends',
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = stories;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || tab !== 'posts') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, tab]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['friends'] });
  const onError = (err: unknown) => toast.error(errorText(err));
  const name = p ? shortName(p.user.displayName) : '';

  const send = useMutation({
    mutationFn: () => friendsApi.sendRequest(userId),
    onSuccess: (r) => {
      toast.success(r.relation === 'friend' ? `Bạn và ${name} đã là bạn bè` : 'Đã gửi lời mời kết bạn');
      pushSuggest.trigger('friends');
      void refresh();
    },
    onError,
  });
  const accept = useMutation({
    mutationFn: (requestId: string) => friendsApi.accept(requestId),
    onSuccess: () => {
      toast.success(`Bạn và ${name} đã là bạn bè`);
      void refresh();
    },
    onError,
  });
  const removeRequest = useMutation({ mutationFn: (requestId: string) => friendsApi.removeRequest(requestId), onSuccess: () => void refresh(), onError });
  const unfriend = useMutation({
    mutationFn: () => friendsApi.unfriend(userId),
    onSuccess: () => {
      setConfirmUnfriend(false);
      toast.info('Đã hủy kết bạn');
      void refresh();
    },
    onError,
  });
  const busy = send.isPending || accept.isPending || removeRequest.isPending;

  if (profile.isLoading) {
    return (
      <Page title="Trang cá nhân" onBack={goBack}>
        <Skeleton height={220} />
      </Page>
    );
  }
  if (!p) {
    const notFound = profile.error instanceof ApiRequestError && profile.error.status === 404;
    return (
      <Page title="Trang cá nhân" onBack={goBack}>
        {notFound ? (
          <ErrorState title="Không tìm thấy người này" message="Người này không có trong Hội bạn bè." />
        ) : (
          <ErrorState onRetry={() => void profile.refetch()} />
        )}
      </Page>
    );
  }

  const person = { id: p.user.id, displayName: p.user.displayName };
  const isSelf = p.relation === 'self';

  function actions() {
    if (!p) return null;
    const more = (
      <button type="button" className="btn btn-secondary profile-head__more" aria-label="Tùy chọn khác" onClick={() => setMenuOpen(true)}>
        <Icon name="moreHorizontal" size={20} />
      </button>
    );
    switch (p.relation) {
      case 'self':
        return (
          <Link to="/friends/me" className="btn btn-secondary btn-block">
            <Icon name="edit" size={18} /> Chỉnh sửa trang cá nhân
          </Link>
        );
      case 'friend':
        return (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => setMenuOpen(true)}>
            <Icon name="userCheck" size={18} /> Bạn bè
          </button>
        );
      case 'outgoing':
        return (
          <>
            <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => p.requestId && removeRequest.mutate(p.requestId)}>
              Hủy lời mời
            </button>
            {more}
          </>
        );
      case 'incoming':
        return (
          <>
            <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => p.requestId && accept.mutate(p.requestId)}>
              Xác nhận
            </button>
            <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => p.requestId && removeRequest.mutate(p.requestId)}>
              Xóa
            </button>
            {more}
          </>
        );
      default:
        return (
          <>
            <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => send.mutate()}>
              <Icon name="userPlus" size={18} /> Kết bạn
            </button>
            {more}
          </>
        );
    }
  }

  const posts = stories.data?.pages.flatMap((pg) => pg.items) ?? [];
  const friendItems = friends.data?.pages.flatMap((pg) => pg.items) ?? [];

  return (
    <Page title={p.user.displayName} subtitle="Trang cá nhân" onBack={goBack}>
      <section className="card profile-head" aria-label={`Trang cá nhân của ${p.user.displayName}`}>
        <Avatar name={p.user.displayName} src={p.user.avatarUrl} size={96} ring />
        <h2 className="profile-head__name">{p.user.displayName}</h2>
        {p.user.bio && <p className="profile-head__bio">{p.user.bio}</p>}
        <p className="text-sm text-muted">{p.friendCount} bạn bè</p>
        <MutualLine p={p} />
        <div className="profile-head__actions">{actions()}</div>
      </section>

      {!isSelf && <PushSuggestCard space="friends" text={FRIENDS_PUSH_TEXT} />}

      {!canSee && (
        <div className="card">
          <EmptyState
            art="🔒"
            title={`Kết bạn với ${name} để xem bài viết`}
            hint={`Chỉ bạn bè của ${name} mới thấy bài viết và danh sách bạn bè.`}
          />
        </div>
      )}

      {canSee && (
        <>
          <SegmentedControl
            mode="radio"
            ariaLabel="Nội dung trang cá nhân"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'posts', label: 'Bài viết' },
              { value: 'friends', label: `Bạn bè (${p.friendCount})` },
            ]}
          />

          {tab === 'posts' && (
            <>
              {stories.isLoading && <Skeleton height={240} count={2} />}
              {stories.isError && <ErrorState onRetry={() => void stories.refetch()} />}
              {stories.isSuccess && posts.length === 0 && (
                <div className="card">
                  <EmptyState art="📝" title={isSelf ? 'Bạn chưa đăng bài nào' : `${name} chưa đăng bài nào`} />
                </div>
              )}
              {posts.map((s) => (
                <FriendStoryCard key={s.id} story={s} onEdit={setEditing} onComment={() => navigate(`/friends/posts/${s.id}`)} />
              ))}
              <div ref={sentinel} aria-hidden="true" />
              {isFetchingNextPage && <Skeleton height={220} />}
            </>
          )}

          {tab === 'friends' && (
            <>
              {friends.isLoading && <Skeleton height={64} count={3} />}
              {friends.isError && <ErrorState onRetry={() => void friends.refetch()} />}
              {friends.isSuccess && friendItems.length === 0 && (
                <div className="card">
                  <EmptyState art="🤝" title="Chưa có bạn bè" />
                </div>
              )}
              {friendItems.length > 0 && (
                <div className="list">
                  {friendItems.map((u) => (
                    <Link key={u.id} to={`/friends/u/${u.id}`} className="list__item">
                      <Avatar name={u.displayName} src={u.avatarUrl} size={44} />
                      <span className="list__body">
                        <span className="list__label person__name">{u.displayName}</span>
                      </span>
                      <Icon name="chevronRight" className="text-muted" />
                    </Link>
                  ))}
                </div>
              )}
              {friends.hasNextPage && (
                <button type="button" className="btn btn-outline" disabled={friends.isFetchingNextPage} onClick={() => void friends.fetchNextPage()}>
                  Xem thêm
                </button>
              )}
            </>
          )}
        </>
      )}

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={p.user.displayName}>
        <div className="list">
          {p.relation === 'friend' && (
            <button
              type="button"
              className="list__item"
              onClick={() => {
                setMenuOpen(false);
                setConfirmUnfriend(true);
              }}
            >
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="x" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Hủy kết bạn</span>
              </span>
            </button>
          )}
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setMenuOpen(false);
              setReporting({ type: 'user', id: p.user.id, owner: person });
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="alert" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Báo cáo</span>
            </span>
          </button>
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setMenuOpen(false);
              setBlocking(person);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="shield" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label text-danger">Chặn {name}</span>
            </span>
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={confirmUnfriend} onClose={() => setConfirmUnfriend(false)} title={`Hủy kết bạn với ${p.user.displayName}?`}>
        <div className="stack">
          <p className="text-muted">Hai bạn sẽ không còn thấy bài viết của nhau. Bạn có thể kết bạn lại sau.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmUnfriend(false)}>
              Không
            </button>
            <button type="button" className="btn btn-danger" disabled={unfriend.isPending} onClick={() => unfriend.mutate()}>
              Hủy kết bạn
            </button>
          </div>
        </div>
      </BottomSheet>

      <ReportSheet target={reporting} onClose={() => setReporting(null)} onBlock={setBlocking} />
      <BlockSheet user={blocking} onClose={() => setBlocking(null)} onBlocked={() => navigate('/friends', { replace: true })} />
      <FriendComposer open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
