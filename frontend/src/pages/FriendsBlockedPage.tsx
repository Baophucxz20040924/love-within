import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { FRIEND_BLOCKS_KEY, friendsApi } from '../features/friends/api';
import { ApiRequestError } from '../lib/apiClient';
import { timeAgo } from '../lib/format';
import type { BlockedFriend } from '../lib/types';

/** /friends/me/blocked — people I blocked, with "Bỏ chặn". */
export function FriendsBlockedPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const blocks = useQuery({ queryKey: FRIEND_BLOCKS_KEY, queryFn: friendsApi.blocks });

  const unblock = useMutation({
    mutationFn: (userId: string) => friendsApi.unblock(userId),
    onSuccess: (_r, userId) => {
      qc.setQueryData<BlockedFriend[]>(FRIEND_BLOCKS_KEY, (list) => list?.filter((b) => b.user.id !== userId));
      toast.info('Đã bỏ chặn. Hai bạn có thể tìm thấy và kết bạn lại với nhau.');
      void qc.invalidateQueries({ queryKey: ['friends'] });
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
  });

  return (
    <Page title="Đã chặn" back="/friends/me">
      <p className="text-sm text-muted">
        Người bị chặn không tìm thấy bạn, không xem được bài viết và không kết bạn được với bạn. Họ không được báo.
      </p>
      {blocks.isLoading && <Skeleton height={64} count={2} />}
      {blocks.isError && <ErrorState onRetry={() => void blocks.refetch()} />}
      {blocks.isSuccess && blocks.data.length === 0 && (
        <div className="card">
          <EmptyState art="🛡️" title="Bạn chưa chặn ai" />
        </div>
      )}
      {blocks.data && blocks.data.length > 0 && (
        <div className="list">
          {blocks.data.map((b) => (
            <div key={b.user.id} className="list__item">
              <Avatar name={b.user.displayName} src={b.user.avatarUrl} size={44} />
              <span className="list__body">
                <span className="list__label person__name">{b.user.displayName}</span>
                <span className="list__meta person__meta">Đã chặn {timeAgo(b.blockedAt)}</span>
              </span>
              <button type="button" className="btn btn-secondary" disabled={unblock.isPending} onClick={() => unblock.mutate(b.user.id)}>
                Bỏ chặn
              </button>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
