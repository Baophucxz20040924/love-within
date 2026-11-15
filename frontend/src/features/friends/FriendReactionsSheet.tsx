import { useInfiniteQuery } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { ErrorState, Skeleton } from '../../components/StatusViews';
import { ApiRequestError } from '../../lib/apiClient';
import type { FriendStoryReactionsPage, StoryReactor } from '../../lib/types';
import { useAuth } from '../auth/AuthContext';
import { ReactionPeople } from '../stories/ReactionPeople';
import { friendReactionsKey, friendStoriesApi } from './api';

/** Mutations can shift cursors while paging; show each person at most once. */
export function uniqueReactors(pages: FriendStoryReactionsPage[]): StoryReactor[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.items.filter((person) => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  }));
}

/** Mounted only while open, so no list request runs for unopened cards. */
export function FriendReactionsSheet({ storyId, onClose }: { storyId: string; onClose: () => void }) {
  const { me } = useAuth();
  const list = useInfiniteQuery({
    queryKey: friendReactionsKey(storyId),
    queryFn: ({ pageParam }) => friendStoriesApi.reactions(storyId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchOnMount: 'always',
    retry: (count, error) => !(error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) && count < 2,
  });
  const denied = list.error instanceof ApiRequestError && (list.error.status === 403 || list.error.status === 404);
  // A stale cache must not flash while the server rechecks access on opening or refresh.
  const checking = list.isPending || (list.isFetching && !list.isFetchingNextPage);
  const people = list.data ? uniqueReactors(list.data.pages) : [];
  const showError = !checking && list.isError && (!list.isFetchNextPageError || denied);

  return (
    <BottomSheet open onClose={onClose} title="Người đã thả cảm xúc">
      {checking ? <Skeleton height={52} count={3} /> : showError ? (
        <ErrorState
          message={denied ? 'Bạn không còn quyền xem danh sách này.' : undefined}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <>
          {people.length ? <ReactionPeople people={people} myId={me?.user.id} /> : <p className="text-muted">Chưa có ai để hiện ở đây.</p>}
          {list.isFetchNextPageError && <ErrorState onRetry={() => void list.fetchNextPage()} />}
          {list.hasNextPage && !list.isFetchNextPageError && (
            <button type="button" className="btn btn-outline reaction-people__more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}
            </button>
          )}
        </>
      )}
    </BottomSheet>
  );
}
