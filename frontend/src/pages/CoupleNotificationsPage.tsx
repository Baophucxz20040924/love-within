import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { useApprovals } from '../features/approvals/useApprovals';
import { COUPLE_NOTIFICATIONS_KEY, COUPLE_NOTIFICATION_UNREAD_KEY, coupleNotificationsApi, type CoupleNotification } from '../features/notifications/api';
import { notificationIcon, notificationLabel, notificationTarget } from '../features/notifications/presentation';
import { timeAgo } from '../lib/format';
import { currentAccessEpoch } from '../lib/apiClient';
import { tokenStore } from '../lib/tokenStore';
import { appLockEpoch, isAppLockCurrent } from '../features/appLock/store';
import { ApprovalsPage } from './ApprovalsPage';

const ACTOR_LABELS = new Set(['water_pending', 'proposal_created', 'redemption_requested', 'redemption_answered', 'couple_story', 'couple_comment', 'question_answered', 'letter_opened', 'event_created', 'nudge', 'bucket_done', 'moment_posted']);

function ActivityFeed() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { me } = useAuth();
  const partner = me?.couple?.members.find((member) => member.id !== me.user.id);
  const acknowledged = useRef(new Set<string>());
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function attempt() {
    const generation = tokenStore.generation(), access = currentAccessEpoch(), lock = appLockEpoch();
    return () => mounted.current && tokenStore.isCurrent(generation) && access === currentAccessEpoch() && isAppLockCurrent(lock);
  }
  function assertCurrent(valid: () => boolean) {
    if (!valid()) throw new Error('Quyền truy cập đã thay đổi. Hãy tải lại thông báo.');
  }
  const feed = useInfiniteQuery({
    queryKey: COUPLE_NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => coupleNotificationsApi.list(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const seen = useMutation({
    retry: false,
    mutationFn: async ({ tokens, valid }: { tokens: string[]; valid: () => boolean }) => {
      for (const token of tokens) {
        assertCurrent(valid);
        await coupleNotificationsApi.seen(token);
        assertCurrent(valid);
        acknowledged.current.add(token);
      }
    },
    onSettled: (_result, _error, { valid }) => {
      pending.current = false;
      if (valid()) void qc.invalidateQueries({ queryKey: COUPLE_NOTIFICATION_UNREAD_KEY });
    },
  });
  const markSeen = seen.mutate;
  useEffect(() => {
    if (pending.current || seen.isError) return;
    const tokens = [...new Set((feed.data?.pages ?? []).map((page) => page.watermark).filter((token) => token && !acknowledged.current.has(token)))];
    const valid = attempt();
    if (tokens.length && valid()) { pending.current = true; markSeen({ tokens, valid }); }
  }, [feed.data, markSeen, seen.isError, seen.isPending]);

  const read = useMutation({
    retry: false,
    mutationFn: async ({ id, valid }: { id: string; valid: () => boolean }) => {
      assertCurrent(valid);
      await coupleNotificationsApi.read(id);
      assertCurrent(valid);
    },
    onSuccess: (_result, { valid }) => { if (valid()) void qc.invalidateQueries({ queryKey: COUPLE_NOTIFICATIONS_KEY }); },
  });
  const readAll = useMutation({
    retry: false,
    // The endpoint limits a request to 25 snapshots. Never include rows that arrived after this click.
    mutationFn: async ({ tokens, valid }: { tokens: string[]; valid: () => boolean }) => {
      for (let i = 0; i < tokens.length; i += 25) {
        assertCurrent(valid);
        await coupleNotificationsApi.readAll(tokens.slice(i, i + 25));
        assertCurrent(valid);
      }
    },
    onSettled: (_result, _error, { valid }) => { if (valid()) void qc.invalidateQueries({ queryKey: COUPLE_NOTIFICATIONS_KEY }); },
  });
  const items = [...new Map((feed.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()];
  const updating = read.isPending || readAll.isPending;
  const tokens = [...new Set((feed.data?.pages ?? []).map((page) => page.watermark).filter(Boolean))];

  function open(item: CoupleNotification) {
    if (updating) return;
    read.reset();
    readAll.reset();
    const target = notificationTarget(item), valid = attempt();
    if (!valid()) return;
    if (item.read) navigate(target);
    else read.mutate({ id: item.id, valid }, { onSuccess: () => { if (valid()) navigate(target); } });
  }

  return <>
    {items.some((item) => !item.read) && <div className="couple-notifications__actions">
      <button type="button" className="btn btn-ghost" disabled={updating || !tokens.length} onClick={() => { const valid = attempt(); if (valid()) { read.reset(); readAll.mutate({ tokens, valid }); } }}>
        {readAll.isPending ? 'Đang lưu…' : 'Đọc các thông báo đã tải'}
      </button>
    </div>}
    {(read.isError || readAll.isError) && <p className="form-error" role="alert">Không lưu được trạng thái đã đọc. Hãy thử lại.</p>}
    {seen.isError && <div className="form-error" role="alert">Chưa thể cập nhật số thông báo mới.{' '}
      <button type="button" className="btn btn-ghost" disabled={seen.isPending} onClick={() => {
        seen.reset();
        const remaining = tokens.filter((token) => !acknowledged.current.has(token));
        const valid = attempt();
        if (remaining.length && !pending.current && valid()) { pending.current = true; markSeen({ tokens: remaining, valid }); }
      }}>Thử lại</button>
    </div>}
    {feed.isLoading && <Skeleton height={72} count={4} />}
    {feed.isError && !items.length && <ErrorState onRetry={() => void feed.refetch()} />}
    {feed.isSuccess && items.length === 0 && <div className="card"><EmptyState art="🔔" title="Chưa có thông báo nào" hint="Những hoạt động mới của hai bạn sẽ xuất hiện ở đây." /></div>}
    {items.length > 0 && <div className="list notif-list">
      {items.map((item) => {
        const actor = item.actorId && partner?.id === item.actorId ? partner : null;
        const showActor = actor && ACTOR_LABELS.has(item.type);
        return <button key={item.id} type="button" className={`list__item notif${item.read ? '' : ' is-unread'}`} disabled={updating} onClick={() => open(item)}>
          <span className="notif__avatar">
            {showActor ? <Avatar name={actor.displayName} src={actor.avatarUrl} size={48} /> : <span className="notif__system" aria-hidden="true"><Icon name={notificationIcon(item.type)} size={24} /></span>}
            {showActor && <span className="notif__badge" aria-hidden="true"><Icon name={notificationIcon(item.type)} size={12} strokeWidth={2.6} /></span>}
          </span>
          <span className="list__body">
            {!item.read && <span className="visually-hidden">Chưa đọc. </span>}
            <span className="notif__text">{showActor ? <><strong>{actor.displayName}</strong> {notificationLabel(item.type)}</> : ACTOR_LABELS.has(item.type) ? <>Người ấy {notificationLabel(item.type)}</> : notificationLabel(item.type)}</span>
            <span className="notif__time">{timeAgo(item.createdAt)}</span>
          </span>
          {!item.read && <span className="notif__dot" aria-hidden="true" />}
        </button>;
      })}
    </div>}
    {feed.isFetchNextPageError && <div className="form-error" role="alert">Không tải được thông báo cũ. Hãy thử lại.</div>}
    {feed.hasNextPage && <button type="button" className="btn btn-outline btn-block" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>{feed.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}</button>}
    {feed.isRefetchError && !feed.isFetchNextPageError && items.length > 0 && <div className="form-error" role="alert">Không cập nhật được thông báo. <button type="button" className="btn btn-ghost" onClick={() => void feed.refetch()}>Thử lại</button></div>}
  </>;
}

export function CoupleNotificationsPage() {
  const [search, setSearch] = useSearchParams();
  const filter = search.get('filter') === 'approvals' ? 'approvals' : 'activity';
  const { count, isError } = useApprovals();
  return <Page title="Thông báo" subtitle="Không gian đôi" back="/" bell={false}>
    <SegmentedControl mode="group" ariaLabel="Chọn thông báo" value={filter} options={[
      { value: 'activity', label: 'Hoạt động' },
      { value: 'approvals', label: `Cần duyệt${!isError && count ? ` (${count})` : ''}` },
    ]} onChange={(value) => setSearch(value === 'approvals' ? { filter: 'approvals' } : {})} />
    {filter === 'approvals' ? <ApprovalsPage /> : <ActivityFeed />}
  </Page>;
}
