import { lazy, type ComponentType } from 'react';

/**
 * The friends space has its own chunks, kept out of the couple app's prefetch list
 * (app/lazyPages.ts): couple sessions never download them.
 */
const loaders = {
  layout: () => import('./FriendsLayout'),
  feed: () => import('../../pages/FriendsFeedPage'),
  people: () => import('../../pages/FriendsPeoplePage'),
  post: () => import('../../pages/FriendPostPage'),
  me: () => import('../../pages/FriendsMePage'),
  notifications: () => import('../../pages/FriendsNotificationsPage'),
  profile: () => import('../../pages/FriendProfilePage'),
  blocked: () => import('../../pages/FriendsBlockedPage'),
  invites: () => import('../../pages/FriendsInvitesPage'),
  notificationSettings: () => import('../../pages/FriendsNotificationSettingsPage'),
  events: () => import('../../pages/FriendEventsPage'),
  event: () => import('../../pages/FriendEventPage'),
  outings: () => import('../../pages/FriendOutingsPage'),
  outing: () => import('../../pages/FriendOutingPage'),
  scam: () => import('../scam/ScamGamePage'),
};

function page<K extends string, M extends Record<K, ComponentType>>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }));
}

export const FriendsLayout = page(loaders.layout, 'FriendsLayout');
export const FriendsFeedPage = page(loaders.feed, 'FriendsFeedPage');
export const FriendsPeoplePage = page(loaders.people, 'FriendsPeoplePage');
export const FriendPostPage = page(loaders.post, 'FriendPostPage');
export const FriendsMePage = page(loaders.me, 'FriendsMePage');
export const FriendsNotificationsPage = page(loaders.notifications, 'FriendsNotificationsPage');
export const FriendProfilePage = page(loaders.profile, 'FriendProfilePage');
export const FriendsBlockedPage = page(loaders.blocked, 'FriendsBlockedPage');
export const FriendsInvitesPage = page(loaders.invites, 'FriendsInvitesPage');
export const FriendsNotificationSettingsPage = page(loaders.notificationSettings, 'FriendsNotificationSettingsPage');
export const FriendEventsPage = page(loaders.events, 'FriendEventsPage');
export const FriendEventPage = page(loaders.event, 'FriendEventPage');
export const FriendOutingsPage = page(loaders.outings, 'FriendOutingsPage');
export const FriendOutingPage = page(loaders.outing, 'FriendOutingPage');
export const ScamGamePage = page(loaders.scam, 'ScamGamePage');
/** Public landing of /j/<code>: loaded on its own (not prefetched with the space). */
export const InviteLandingPage = page(() => import('../../pages/InviteLandingPage'), 'InviteLandingPage');

/** The entire speculative budget for one friends shell activation. */
export const friendsPrefetchCandidates = [
  { path: '/friends/people', load: loaders.people },
  { path: '/friends/events', load: loaders.events },
] as const;
