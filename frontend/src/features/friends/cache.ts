import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { FriendStory, FriendStoryPage } from '../../lib/types';
import { FRIEND_FEED_KEY, FRIEND_USER_STORIES, friendStoryKey } from './api';

type Feed = InfiniteData<FriendStoryPage, string | undefined>;

const mapFeed = (fn: (items: FriendStory[]) => FriendStory[]) => (data: Feed | undefined) =>
  data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: fn(p.items) })) } : data;

/** Apply `fn` to one post wherever it is cached: news feed, profile pages and detail. */
export function updateFriendStoryInCache(qc: QueryClient, id: string, fn: (s: FriendStory) => FriendStory): void {
  const update = mapFeed((items) => items.map((s) => (s.id === id ? fn(s) : s)));
  qc.setQueryData<Feed>(FRIEND_FEED_KEY, update);
  qc.setQueriesData<Feed>({ queryKey: FRIEND_USER_STORIES }, update);
  qc.setQueryData<FriendStory>(friendStoryKey(id), (s) => (s ? fn(s) : s));
}

export function replaceFriendStoryInCache(qc: QueryClient, story: FriendStory): void {
  updateFriendStoryInCache(qc, story.id, () => story);
}

export function prependFriendStoryToFeed(qc: QueryClient, story: FriendStory): void {
  qc.setQueryData<Feed>(FRIEND_FEED_KEY, (data) => {
    if (!data || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, items: [story, ...first.items] }, ...rest] };
  });
}

/** Deleted, hidden, or its author blocked: drop it from every list. */
export function removeFriendStoryFromCache(qc: QueryClient, id: string): void {
  const remove = mapFeed((items) => items.filter((s) => s.id !== id));
  qc.setQueryData<Feed>(FRIEND_FEED_KEY, remove);
  qc.setQueriesData<Feed>({ queryKey: FRIEND_USER_STORIES }, remove);
  qc.removeQueries({ queryKey: friendStoryKey(id) });
}

/** Blocked: every post of that person leaves the lists at once (the refetch that follows confirms it). */
export function removeAuthorFromCache(qc: QueryClient, authorId: string): void {
  const remove = mapFeed((items) => items.filter((s) => s.author.id !== authorId));
  qc.setQueryData<Feed>(FRIEND_FEED_KEY, remove);
  qc.setQueriesData<Feed>({ queryKey: FRIEND_USER_STORIES }, remove);
}
