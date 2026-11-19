import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { FRIEND_FEED_KEY, friendStoriesApi, friendStoryKey } from '../features/friends/api';
import { FriendComments, storyCommentApi } from '../features/friends/FriendComments';
import { FriendComposer } from '../features/friends/FriendComposer';
import { FriendStoryCard } from '../features/friends/FriendStoryCard';
import { ApiRequestError } from '../lib/apiClient';
import type { FriendStory, FriendStoryPage } from '../lib/types';

/** /friends/posts/:id — one post with its comments. `?comment=<id>` (from a notification) opens at that comment. */
export function FriendPostPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const focusCommentId = params.get('comment');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<FriendStory | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const commentApi = useMemo(() => storyCommentApi(id), [id]);

  const story = useQuery<FriendStory>({
    queryKey: friendStoryKey(id),
    queryFn: ({ signal }) => friendStoriesApi.get(id, signal),
    // Show the copy already in the feed instantly while the fresh one loads.
    placeholderData: () =>
      qc
        .getQueryData<InfiniteData<FriendStoryPage>>(FRIEND_FEED_KEY)
        ?.pages.flatMap((p) => p.items)
        .find((s) => s.id === id),
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 1,
  });
  const notFound = story.error instanceof ApiRequestError && story.error.status === 404;

  return (
    <Page title="Bài viết" back="/friends">
      {story.isLoading && <Skeleton height={320} />}
      {story.isError &&
        (notFound ? (
          <ErrorState title="Bài viết không còn nữa" message="Bài viết đã bị xóa, hoặc bạn không còn là bạn bè với người đăng." />
        ) : (
          <ErrorState onRetry={() => void story.refetch()} />
        ))}
      {story.data && !story.isError && (
        <>
          <FriendStoryCard
            story={story.data}
            clamp={false}
            onEdit={setEditing}
            onDeleted={() => navigate('/friends', { replace: true })}
            onComment={() => setFocusKey((k) => k + 1)}
          />
          <FriendComments api={commentApi} focusKey={focusKey} focusCommentId={focusCommentId} />
        </>
      )}
      <FriendComposer open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
