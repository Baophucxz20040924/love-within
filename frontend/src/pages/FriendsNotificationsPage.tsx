import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { FRIEND_NOTIFICATIONS_KEY, FRIENDS_UNREAD_KEY, friendsApi } from '../features/friends/api';
import { timeAgo } from '../lib/format';
import type { FriendNotification, FriendNotificationPage, FriendNotificationType, FriendsUnread } from '../lib/types';

type Feed = InfiniteData<FriendNotificationPage, string | undefined>;

const ICON: Record<FriendNotificationType, IconName> = {
  friend_request: 'userPlus',
  friend_accepted: 'userCheck',
  story_reaction: 'thumbsUp',
  story_comment: 'messageCircle',
  invite_joined: 'users',
  comment_reply: 'cornerDownRight',
  mention: 'atSign',
  post_mention: 'atSign',
  poll_closed: 'list',
  event_invite: 'calendar',
  event_rsvp: 'check',
  event_changed: 'clock',
  event_cancelled: 'x',
  event_comment: 'messageCircle',
  event_reminder: 'bell',
  outing_invite: 'calendar',
  outing_changed: 'clock',
  outing_review: 'messageCircle',
  outing_closed: 'x',
  outing_settlement: 'check',
  outing_completed: 'check',
};

/** "Long", "Long và Cường", "Long, Cường và 3 người khác". */
function Names({ n }: { n: FriendNotification }) {
  const [a, b] = n.actors;
  if (!a) return null;
  const others = Math.max(0, n.actorCount - (b ? 2 : 1));
  if (!b) {
    return others > 0 ? (
      <>
        <strong>{a.displayName}</strong> và {others} người khác
      </>
    ) : (
      <strong>{a.displayName}</strong>
    );
  }
  return others > 0 ? (
    <>
      <strong>{a.displayName}</strong>, <strong>{b.displayName}</strong> và {others} người khác
    </>
  ) : (
    <>
      <strong>{a.displayName}</strong> và <strong>{b.displayName}</strong>
    </>
  );
}

function Sentence({ n }: { n: FriendNotification }): ReactNode {
  const excerpt = n.entity && 'excerpt' in n.entity ? n.entity.excerpt : '';
  const quote = excerpt ? `: “${excerpt}”` : '.';
  switch (n.type) {
    case 'friend_request':
      return (
        <>
          <Names n={n} /> đã gửi cho bạn lời mời kết bạn.
        </>
      );
    case 'friend_accepted':
      return (
        <>
          <Names n={n} /> đã chấp nhận lời mời kết bạn của bạn.
        </>
      );
    case 'story_reaction':
      return (
        <>
          <Names n={n} /> đã bày tỏ cảm xúc về bài viết của bạn{quote}
        </>
      );
    case 'story_comment':
      return (
        <>
          <Names n={n} /> đã bình luận về bài viết của bạn{quote}
        </>
      );
    case 'invite_joined':
      return (
        <>
          <Names n={n} /> đã vào Hội bạn bè qua link mời của bạn. Hai bạn giờ là bạn bè.
        </>
      );
    case 'comment_reply':
      return (
        <>
          <Names n={n} /> đã trả lời bình luận của bạn{quote}
        </>
      );
    case 'mention':
      return (
        <>
          <Names n={n} /> đã nhắc đến bạn trong một bình luận{quote}
        </>
      );
    case 'post_mention':
      return (
        <>
          <Names n={n} /> đã nhắc đến bạn trong một bài viết{quote}
        </>
      );
    case 'poll_closed':
      return <>Bình chọn của bạn đã kết thúc. Xem kết quả{quote}</>;
    case 'event_invite':
      return (
        <>
          <Names n={n} /> đã mời bạn tham gia kèo{quote}
        </>
      );
    case 'event_rsvp':
      return (
        <>
          <Names n={n} /> sẽ đi kèo của bạn{quote}
        </>
      );
    case 'event_changed':
      return (
        <>
          <Names n={n} /> đã đổi giờ hoặc địa điểm của kèo{quote}
        </>
      );
    case 'event_cancelled':
      return (
        <>
          <Names n={n} /> đã hủy kèo{quote}
        </>
      );
    case 'event_comment':
      return (
        <>
          <Names n={n} /> đã bình luận trong kèo{quote}
        </>
      );
    case 'event_reminder':
      return <>Còn khoảng 2 giờ nữa là tới kèo{quote}</>;
    // Outing history is intentionally generic; restricted rows have no actors or private excerpts.
    case 'outing_invite':
      return <>Bạn có lời mời mới cho một buổi đi chơi.</>;
    case 'outing_changed':
      return <>Buổi đi chơi có cập nhật mới.</>;
    case 'outing_review':
      return <>Có một buổi đi chơi đang chờ bạn xem lại.</>;
    case 'outing_closed':
      return <>Một buổi đi chơi đã đóng.</>;
    case 'outing_settlement':
      return <>Có cập nhật mới về phần thanh toán của buổi đi chơi.</>;
    case 'outing_completed':
      return <>Một buổi đi chơi đã hoàn tất.</>;
  }
}

function targetOf(n: FriendNotification): string {
  if (n.entity?.kind === 'story') return `/friends/posts/${n.entity.id}`;
  // Replies and mentions open the post at that comment.
  if (n.entity?.kind === 'comment') return `/friends/posts/${n.entity.storyId}?comment=${n.entity.id}`;
  if (n.entity?.kind === 'event') return `/friends/events/${n.entity.id}`;
  if (n.entity?.kind === 'outing') return `/friends/outings/${n.entity.id}`;
  if (n.type === 'friend_request') return '/friends/people';
  return n.actors[0] ? `/friends/u/${n.actors[0].id}` : '/friends';
}

/** /friends/notifications — who friended me, reacted to or commented on my posts. */
export function FriendsNotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sentinel = useRef<HTMLDivElement>(null);

  const feed = useInfiniteQuery({
    queryKey: FRIEND_NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => friendsApi.notifications(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const seen = useMutation({
    mutationFn: friendsApi.notificationsSeen,
    onSuccess: () => {
      qc.setQueryData<FriendsUnread>(FRIENDS_UNREAD_KEY, (u) => (u ? { ...u, notifications: 0, notificationsSaturated: false } : u));
      void qc.invalidateQueries({ queryKey: FRIENDS_UNREAD_KEY });
    },
  });
  // Opening the page clears the badge, but failures remain visible and retryable.
  const seenAt = useRef(0);
  const markSeen = seen.mutate;
  useEffect(() => {
    const at = feed.dataUpdatedAt;
    if (!at || at <= seenAt.current) return;
    seenAt.current = at;
    markSeen();
  }, [feed.dataUpdatedAt, markSeen]);

  const markRead = (id?: string) =>
    qc.setQueryData<Feed>(FRIEND_NOTIFICATIONS_KEY, (data) =>
      data
        ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((n) => (!id || n.id === id ? { ...n, read: true } : n)) })) }
        : data,
    );
  const read = useMutation({
    mutationFn: friendsApi.notificationRead,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: FRIEND_NOTIFICATIONS_KEY });
      const previous = qc.getQueryData<Feed>(FRIEND_NOTIFICATIONS_KEY);
      markRead(id);
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(FRIEND_NOTIFICATIONS_KEY, context.previous);
    },
  });
  const readAll = useMutation({
    mutationFn: friendsApi.notificationsReadAll,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: FRIEND_NOTIFICATIONS_KEY });
      const previous = qc.getQueryData<Feed>(FRIEND_NOTIFICATIONS_KEY);
      markRead();
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) qc.setQueryData(FRIEND_NOTIFICATIONS_KEY, context.previous);
    },
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

  const items = [...new Map((feed.data?.pages.flatMap((p) => p.items) ?? []).map((n) => [n.id, n])).values()];
  const anyUnread = items.some((n) => !n.read);
  const updating = read.isPending || readAll.isPending;

  function open(n: FriendNotification) {
    if (updating) return;
    read.reset();
    readAll.reset();
    if (!n.read) read.mutate(n.id, { onSuccess: () => navigate(targetOf(n)) });
    else navigate(targetOf(n));
  }

  return (
    <Page
      title="Thông báo"
      subtitle="Hội bạn bè"
      bell={false}
      actions={
        anyUnread ? (
          <button type="button" className="btn btn-ghost" disabled={updating} onClick={() => { read.reset(); readAll.mutate(); }}>
            {readAll.isPending ? 'Đang lưu…' : 'Đọc hết'}
          </button>
        ) : undefined
      }
    >
      {(read.isError || readAll.isError) && (
        <p className="form-error" role="alert">Không lưu được trạng thái đã đọc. Thông báo đã được khôi phục; hãy thử lại.</p>
      )}
      {seen.isError && (
        <div className="form-error" role="alert">
          Chưa thể cập nhật số thông báo mới.{' '}
          <button type="button" className="btn btn-ghost" disabled={seen.isPending} onClick={() => seen.mutate()}>Thử lại</button>
        </div>
      )}
      {feed.isLoading && <Skeleton height={72} count={4} />}
      {feed.isError && <ErrorState onRetry={() => void feed.refetch()} />}
      {feed.isSuccess && items.length === 0 && (
        <div className="card">
          <EmptyState
            art="🔔"
            title="Chưa có thông báo nào"
            hint="Khi bạn bè kết bạn, thả cảm xúc, bình luận, trả lời hay nhắc tên bạn, mời bạn đi kèo, hoặc bình chọn của bạn kết thúc, bạn sẽ thấy ở đây."
          />
        </div>
      )}
      {items.length > 0 && (
        <div className="list notif-list">
          {items.map((n) => (
            <button key={n.id} type="button" className={`list__item notif${n.read ? '' : ' is-unread'}`} disabled={updating} onClick={() => open(n)}>
              <span className="notif__avatar">
                {n.actors[0] ? (
                  <Avatar name={n.actors[0].displayName} src={n.actors[0].avatarUrl} size={48} />
                ) : (
                  // poll_closed, event_reminder: nobody did it, the app tells you (no badge: the tile is the icon).
                  <span className="notif__system" aria-hidden="true">
                    <Icon name={ICON[n.type]} size={24} />
                  </span>
                )}
                {n.actors[0] && (
                  <span className={`notif__badge notif__badge--${n.type}`} aria-hidden="true">
                    <Icon name={ICON[n.type]} size={12} strokeWidth={2.6} />
                  </span>
                )}
              </span>
              <span className="list__body">
                {!n.read && <span className="visually-hidden">Chưa đọc. </span>}
                <span className="notif__text">
                  <Sentence n={n} />
                </span>
                {n.entity?.kind === 'outing' && n.entity.restricted && (
                  <span className="chip chip--warning">Lịch sử giới hạn</span>
                )}
                <span className="notif__time">{timeAgo(n.updatedAt)}</span>
              </span>
              {!n.read && <span className="notif__dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
      <div ref={sentinel} aria-hidden="true" />
      {isFetchingNextPage && <Skeleton height={72} />}
    </Page>
  );
}
