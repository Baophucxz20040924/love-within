import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { CommentSection } from '../features/stories/Comments';
import { STORY_FEED_KEY, storiesApi, storyKey } from '../features/stories/api';
import { StoryCard } from '../features/stories/StoryCard';
import { StoryComposer } from '../features/stories/StoryComposer';
import { ApiRequestError } from '../lib/apiClient';
import { useCommentDraftDenial } from '../hooks/useCommentDraft';
import type { Story, StoryPage } from '../lib/types';

/** /stories/:id — one post with its comments. */
export function StoryDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Story | null>(null);
  const [focusKey, setFocusKey] = useState(0);

  const story = useQuery<Story>({
    queryKey: storyKey(id),
    queryFn: ({ signal }) => storiesApi.get(id, signal),
    // Show the copy already in the feed instantly while the fresh one loads.
    placeholderData: () =>
      qc
        .getQueryData<InfiniteData<StoryPage>>(STORY_FEED_KEY)
        ?.pages.flatMap((p) => p.items)
        .find((s) => s.id === id),
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 1,
  });
  const discardDraft = useCommentDraftDenial('story', id, story.error);
  const notFound = story.error instanceof ApiRequestError && story.error.status === 404;

  return (
    <Page title="Bài viết" back="/stories">
      {story.isLoading && <Skeleton height={320} />}
      {story.isError &&
        (notFound ? (
          <ErrorState title="Bài viết không còn nữa" message="Bài viết đã bị xóa hoặc không tồn tại." />
        ) : (
          <ErrorState onRetry={() => void story.refetch()} />
        ))}
      {story.data && !story.isError && (
        <>
          <StoryCard
            story={story.data}
            clamp={false}
            onEdit={setEditing}
            onDeleted={() => { discardDraft(); navigate('/stories', { replace: true }); }}
            onComment={() => setFocusKey((k) => k + 1)}
          />
          <CommentSection storyId={id} focusKey={focusKey} />
        </>
      )}
      <StoryComposer open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
