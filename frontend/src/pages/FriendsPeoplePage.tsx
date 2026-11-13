import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { FRIENDS_OVERVIEW_KEY, friendSearchKey, friendsApi } from '../features/friends/api';
import { FriendSuggestions } from '../features/friends/FriendSuggestions';
import { BlockSheet } from '../features/friends/SafetySheets';
import { FRIENDS_PUSH_TEXT } from '../features/friends/pushCopy';
import { PushSuggestCard } from '../features/push/PushSuggestCard';
import { pushSuggest } from '../features/push/suggest';
import { ApiRequestError } from '../lib/apiClient';
import { formatDate, shortName, timeAgo } from '../lib/format';
import type { FriendPerson, FriendUser } from '../lib/types';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** Wait until typing pauses before searching. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Photo + name open the profile; the action button on the right stays separate. */
function PersonRow({ user, meta, children }: { user: FriendUser; meta?: string; children?: ReactNode }) {
  return (
    <div className="list__item">
      <Link to={`/friends/u/${user.id}`} className="person__link">
        <Avatar name={user.displayName} src={user.avatarUrl} size={44} />
        <span className="list__body">
          <span className="list__label person__name">{user.displayName}</span>
          {meta && <span className="list__meta person__meta">{meta}</span>}
        </span>
      </Link>
      {children}
    </div>
  );
}

/** /friends/people — find people, answer friend requests, manage the friend list. */
export function FriendsPeoplePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [options, setOptions] = useState<FriendUser | null>(null);
  const [toUnfriend, setToUnfriend] = useState<FriendUser | null>(null);
  const [blocking, setBlocking] = useState<FriendUser | null>(null);

  const overview = useQuery({ queryKey: FRIENDS_OVERVIEW_KEY, queryFn: friendsApi.overview, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const search = useQuery({
    queryKey: friendSearchKey(term),
    queryFn: () => friendsApi.search(term),
    enabled: term.length > 0,
    staleTime: 10_000,
    // Keep showing the previous results while the next term loads (no skeleton flash on every key).
    placeholderData: (previous) => previous,
  });

  // Requests, friends, search results, badges and the feed all depend on who is a friend.
  const refresh = () => qc.invalidateQueries({ queryKey: ['friends'] });
  const onError = (err: unknown) => toast.error(errorText(err));

  const send = useMutation({
    mutationFn: friendsApi.sendRequest,
    onSuccess: (p) => {
      toast.success(p.relation === 'friend' ? `Bạn và ${p.user.displayName} đã là bạn bè` : 'Đã gửi lời mời kết bạn');
      pushSuggest.trigger('friends');
      void refresh();
    },
    onError,
  });
  const accept = useMutation({
    mutationFn: friendsApi.accept,
    onSuccess: (p) => {
      toast.success(`Bạn và ${p.user.displayName} đã là bạn bè`);
      void refresh();
    },
    onError,
  });
  const removeRequest = useMutation({ mutationFn: friendsApi.removeRequest, onSuccess: () => void refresh(), onError });
  const unfriend = useMutation({
    mutationFn: friendsApi.unfriend,
    onSuccess: () => {
      setToUnfriend(null);
      toast.info('Đã hủy kết bạn');
      void refresh();
    },
    onError,
  });
  const busy = send.isPending || accept.isPending || removeRequest.isPending;

  function actionFor(p: FriendPerson) {
    switch (p.relation) {
      case 'friend':
        return (
          <span className="chip chip--brand">
            <Icon name="userCheck" size={14} /> Bạn bè
          </span>
        );
      case 'outgoing':
        return (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => p.requestId && removeRequest.mutate(p.requestId)}>
            Hủy lời mời
          </button>
        );
      case 'incoming':
        return (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => p.requestId && accept.mutate(p.requestId)}>
            Xác nhận
          </button>
        );
      default:
        return (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send.mutate(p.user.id)}>
            <Icon name="userPlus" size={18} /> Kết bạn
          </button>
        );
    }
  }

  const data = overview.data;
  const searching = term.length > 0;

  return (
    <Page title="Bạn bè" subtitle="Hội bạn bè" bell={false}>
      <form className="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} className="search-box__icon" />
        <input
          className="input search-box__input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm theo tên hoặc email"
          aria-label="Tìm bạn bè theo tên hoặc email"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={100}
        />
      </form>

      <PushSuggestCard space="friends" text={FRIENDS_PUSH_TEXT} />

      {searching && (
        <div className="section">
          <h2 className="section__title">Kết quả</h2>
          {(search.isFetching || q.trim() !== term) && search.data && (
            <p className="text-sm text-muted" role="status">Đang cập nhật kết quả… Kết quả trước vẫn được giữ lại.</p>
          )}
          {search.isLoading && <Skeleton height={64} count={2} />}
          {search.isError && <ErrorState message={errorText(search.error)} onRetry={() => void search.refetch()} />}
          {search.isSuccess && search.data.length === 0 && (
            <div className="card">
              <EmptyState art="🔎" title="Không tìm thấy ai" hint="Chỉ tìm được những người đã vào Hội bạn bè. Với email, hãy nhập đầy đủ." />
            </div>
          )}
          {search.isSuccess && search.data.length > 0 && (
            <div className="list">
              {search.data.map((p) => (
                <PersonRow key={p.user.id} user={p.user} meta={p.relation === 'incoming' ? 'Đã gửi lời mời cho bạn' : undefined}>
                  {actionFor(p)}
                </PersonRow>
              ))}
            </div>
          )}
        </div>
      )}

      {!searching && (
        <div className="list">
          <Link to="/friends/me/invites" className="list__item">
            <span className="icon-tile" aria-hidden="true">
              <Icon name="userPlus" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Mời bạn vào hội</span>
              <span className="list__meta person__meta">Gửi link để bạn bè vào và kết bạn với bạn</span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
        </div>
      )}

      {overview.isLoading && <Skeleton height={64} count={3} />}
      {overview.isError && <ErrorState onRetry={() => void overview.refetch()} />}

      {data && data.incoming.length > 0 && (
        <div className="section">
          <h2 className="section__title">
            Lời mời kết bạn <small>{data.incoming.length}</small>
          </h2>
          {data.incoming.map((r) => (
            <div key={r.id} className="card stack">
              <Link to={`/friends/u/${r.user.id}`} className="row person__link">
                <Avatar name={r.user.displayName} src={r.user.avatarUrl} size={48} />
                <span className="grow">
                  <span className="strong person__name">{r.user.displayName}</span>
                  <span className="text-sm text-muted person__meta">{timeAgo(r.createdAt)}</span>
                </span>
              </Link>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => accept.mutate(r.id)}>
                  Xác nhận
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => removeRequest.mutate(r.id)}>
                  Xóa
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!searching && <FriendSuggestions />}

      {data && (
        <div className="section">
          <h2 className="section__title">
            Bạn bè <small>{data.friends.length}</small>
          </h2>
          {data.friends.length === 0 ? (
            <div className="card">
              <EmptyState
                art="🤝"
                title="Chưa có bạn bè"
                hint="Tìm bạn theo tên hoặc email ở ô phía trên, hoặc gửi link mời cho bạn bè."
                action={
                  <Link to="/friends/me/invites" className="btn btn-outline">
                    <Icon name="userPlus" size={18} /> Mời bạn vào hội
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="list">
              {data.friends.map((f) => (
                <PersonRow key={f.user.id} user={f.user} meta={`Bạn bè từ ${formatDate(f.since)}`}>
                  <button type="button" className="icon-btn" aria-label={`Tùy chọn với ${f.user.displayName}`} onClick={() => setOptions(f.user)}>
                    <Icon name="moreHorizontal" />
                  </button>
                </PersonRow>
              ))}
            </div>
          )}
        </div>
      )}

      {data && data.outgoing.length > 0 && (
        <div className="section">
          <h2 className="section__title">
            Đã gửi lời mời <small>{data.outgoing.length}</small>
          </h2>
          <div className="list">
            {data.outgoing.map((r) => (
              <PersonRow key={r.id} user={r.user} meta={`Đang chờ · ${timeAgo(r.createdAt)}`}>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => removeRequest.mutate(r.id)}>
                  Hủy
                </button>
              </PersonRow>
            ))}
          </div>
        </div>
      )}

      <BottomSheet open={options !== null} onClose={() => setOptions(null)} title={options?.displayName ?? ''}>
        <div className="list">
          <button
            type="button"
            className="list__item"
            onClick={() => {
              const id = options?.id;
              setOptions(null);
              if (id) navigate(`/friends/u/${id}`);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="user" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Xem trang cá nhân</span>
            </span>
          </button>
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setToUnfriend(options);
              setOptions(null);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="x" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Hủy kết bạn</span>
            </span>
          </button>
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setBlocking(options);
              setOptions(null);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="shield" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label text-danger">Chặn {options ? shortName(options.displayName) : ''}</span>
            </span>
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={toUnfriend !== null} onClose={() => setToUnfriend(null)} title={`Hủy kết bạn với ${toUnfriend?.displayName ?? ''}?`}>
        <div className="stack">
          <p className="text-muted">Hai bạn sẽ không còn thấy bài viết của nhau. Bạn có thể kết bạn lại sau.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setToUnfriend(null)}>
              Không
            </button>
            <button type="button" className="btn btn-danger" disabled={unfriend.isPending} onClick={() => toUnfriend && unfriend.mutate(toUnfriend.id)}>
              Hủy kết bạn
            </button>
          </div>
        </div>
      </BottomSheet>

      <BlockSheet user={blocking} onClose={() => setBlocking(null)} />
    </Page>
  );
}
