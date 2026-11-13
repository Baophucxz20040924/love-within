import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/StatusViews';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { FriendSuggestion } from '../../lib/types';
import { pushSuggest } from '../push/suggest';
import { FRIEND_SUGGESTIONS_KEY, friendsApi } from './api';

const TITLE = 'Những người bạn có thể biết';
const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/**
 * "Những người bạn có thể biết" (BB7): friends of my friends as cards that scroll sideways, with Kết bạn and Xóa.
 * Used on the Bạn bè tab and in the empty feed. Shows nothing when there is nobody to suggest.
 */
export function FriendSuggestions() {
  const qc = useQueryClient();
  const toast = useToast();
  // The server keeps the ranking 10 minutes; no need to poll.
  const list = useQuery({ queryKey: FRIEND_SUGGESTIONS_KEY, queryFn: friendsApi.suggestions, staleTime: 60_000, refetchOnWindowFocus: false });

  const drop = (userId: string) =>
    qc.setQueryData<FriendSuggestion[]>(FRIEND_SUGGESTIONS_KEY, (items) => items?.filter((s) => s.user.id !== userId));
  const onError = (err: unknown) => {
    toast.error(errorText(err));
    void list.refetch();
  };

  const add = useMutation({
    mutationFn: (s: FriendSuggestion) => friendsApi.sendRequest(s.user.id),
    onMutate: (s) => drop(s.user.id),
    onSuccess: (p) => {
      toast.success(p.relation === 'friend' ? `Bạn và ${p.user.displayName} đã là bạn bè` : 'Đã gửi lời mời kết bạn');
      pushSuggest.trigger('friends');
      // The sent request shows up on the Bạn bè tab; the person stays out of the suggestions.
      void qc.invalidateQueries({ queryKey: ['friends'] });
    },
    onError,
  });
  const dismiss = useMutation({
    mutationFn: (s: FriendSuggestion) => friendsApi.dismissSuggestion(s.user.id),
    onMutate: (s) => drop(s.user.id),
    onSuccess: () => toast.info('Đã xóa khỏi gợi ý'),
    onError,
  });

  if (list.isLoading) {
    return (
      <section className="section" aria-label={TITLE}>
        <h2 className="section__title">{TITLE}</h2>
        <Skeleton height={230} />
      </section>
    );
  }
  if (list.isError) {
    return (
      <section className="section" aria-label={TITLE}>
        <h2 className="section__title">{TITLE}</h2>
        <p className="text-sm text-muted suggest__error">
          Không tải được gợi ý.{' '}
          <button type="button" className="btn btn-ghost" onClick={() => void list.refetch()}>
            Thử lại
          </button>
        </p>
      </section>
    );
  }
  const items = list.data ?? [];
  if (items.length === 0) return null;

  return (
    <section className="section" aria-label={TITLE}>
      <h2 className="section__title">{TITLE}</h2>
      <ul className="suggest__list">
        {items.map((s) => (
          <li key={s.user.id} className="suggest-card">
            <Link to={`/friends/u/${s.user.id}`} className="suggest-card__link">
              <Avatar name={s.user.displayName} src={s.user.avatarUrl} size={72} />
              <span className="suggest-card__name">{s.user.displayName}</span>
            </Link>
            <span className="suggest-card__mutual">
              <span className="avatar-pair" aria-hidden="true">
                {s.mutualPreview.slice(0, 2).map((u) => (
                  <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size={18} ring />
                ))}
              </span>
              {s.mutualCount} bạn chung
            </span>
            <button
              type="button"
              className="btn btn-primary suggest-card__btn"
              aria-label={`Kết bạn với ${s.user.displayName}`}
              onClick={() => add.mutate(s)}
            >
              <Icon name="userPlus" size={18} /> Kết bạn
            </button>
            <button
              type="button"
              className="btn btn-secondary suggest-card__btn"
              aria-label={`Xóa ${s.user.displayName} khỏi gợi ý`}
              onClick={() => dismiss.mutate(s)}
            >
              Xóa
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
