import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Story, StoryPage } from '../../lib/types';
import { STORY_FEED_KEY, STORY_OTD_KEY, storyKey } from './api';

type Feed = InfiniteData<StoryPage, string | undefined>;

/** Apply `fn` to one story wherever it is cached (feed pages, detail, "on this day"). */
export function updateStoryInCache(qc: QueryClient, id: string, fn: (s: Story) => Story): void {
  qc.setQueryData<Feed>(STORY_FEED_KEY, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((s) => (s.id === id ? fn(s) : s)) })) } : data,
  );
  qc.setQueryData<Story>(storyKey(id), (s) => (s ? fn(s) : s));
  qc.setQueryData<Story[]>(STORY_OTD_KEY, (list) => list?.map((s) => (s.id === id ? fn(s) : s)));
}

export function replaceStoryInCache(qc: QueryClient, story: Story): void {
  updateStoryInCache(qc, story.id, () => story);
}

export function prependStoryToFeed(qc: QueryClient, story: Story): void {
  qc.setQueryData<Feed>(STORY_FEED_KEY, (data) => {
    if (!data || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, items: [story, ...first.items] }, ...rest] };
  });
}

export function removeStoryFromCache(qc: QueryClient, id: string): void {
  qc.setQueryData<Feed>(STORY_FEED_KEY, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((s) => s.id !== id) })) } : data,
  );
  qc.setQueryData<Story[]>(STORY_OTD_KEY, (list) => list?.filter((s) => s.id !== id));
  qc.removeQueries({ queryKey: storyKey(id) });
}
