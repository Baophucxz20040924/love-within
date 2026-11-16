import type { FriendNotificationType } from '../models/FriendNotification.js';

/**
 * Every notification type and how its Web Push behaves (plan/OPERATIONS.md, N3 + N4).
 * A type belongs to one space; its push goes only to that space's subscriptions and is switched by one settings group
 * (users.pushSettings.<space>.<group>).
 *
 * Adding a type (CP6, BB5…): add it to the list of its space and to the table below with its group, then call
 * notificationService.emit({ space, to, type, actorId, entityId, push: { body, url, tag } }) in the feature's service.
 * Friends types that are also kept in the notifications page are listed in models/FriendNotification.ts.
 */

export const COUPLE_PUSH_GROUPS = ['approvals', 'stories', 'reminders', 'nudges', 'moments'] as const;
export const FRIENDS_PUSH_GROUPS = ['social', 'events', 'messages'] as const;
export type CouplePushGroup = (typeof COUPLE_PUSH_GROUPS)[number];
export type FriendsPushGroup = (typeof FRIENDS_PUSH_GROUPS)[number];

/** Couple events are persisted in the Love inbox, independently of their optional push channel. */
export const COUPLE_NOTIFICATION_TYPES = [
  'water_pending',
  'proposal_created',
  'redemption_requested',
  'redemption_answered',
  'couple_story',
  'couple_comment',
  'question_answered',
  'question_both',
  'letter_ready',
  'letter_opened',
  'event_created',
  'event_reminder',
  'nudge',
  'bucket_done',
  'moment_prompt',
  'moment_posted',
  'moment_both',
  'savings_reached',
] as const;
export type CoupleNotificationType = (typeof COUPLE_NOTIFICATION_TYPES)[number];

export interface PushRule<G extends string> {
  group: G;
  /** Timed reminder: the push service drops it after 4 h instead of 24 h. */
  timed?: boolean;
  /** urgency: high (messages, "nhớ bạn"): the phone wakes up for it even when saving battery. */
  urgent?: boolean;
  /** Grouped types: push only for someone new on that post (changing a reaction does not push again). */
  onlyNewActor?: boolean;
}

export const COUPLE_PUSH_RULES: Record<CoupleNotificationType, PushRule<CouplePushGroup>> = {
  savings_reached: { group: 'reminders' },
  water_pending: { group: 'approvals' },
  proposal_created: { group: 'approvals' },
  redemption_requested: { group: 'approvals' },
  redemption_answered: { group: 'approvals' },
  couple_story: { group: 'stories' },
  couple_comment: { group: 'stories' },
  question_answered: { group: 'stories' },
  question_both: { group: 'stories' },
  letter_ready: { group: 'stories' },
  letter_opened: { group: 'stories' },
  event_created: { group: 'reminders' },
  event_reminder: { group: 'reminders', timed: true },
  // CP5 "Nhớ bạn": wakes the phone; a nudge is only worth showing the same day, so TTL 4 h like a reminder.
  nudge: { group: 'nudges', urgent: true, timed: true },
  // CP3: an item of the bucket list was marked done (replaces the "new post" push of its story). New items do not push.
  bucket_done: { group: 'stories' },
  // Daily invitations carry expiresAt; push delivery is capped by the remaining 30-minute reward window.
  moment_prompt: { group: 'moments', timed: true, urgent: true },
  // Invite the partner only within the same session; completion notifications invite viewing instead.
  moment_posted: { group: 'moments', timed: true },
  moment_both: { group: 'moments', timed: true },
};

export const FRIENDS_PUSH_RULES: Record<FriendNotificationType, PushRule<FriendsPushGroup>> = {
  friend_request: { group: 'social' },
  friend_accepted: { group: 'social' },
  story_reaction: { group: 'social', onlyNewActor: true },
  story_comment: { group: 'social' },
  invite_joined: { group: 'social' },
  // BB8: every reply and every mention pushes once (like comments).
  comment_reply: { group: 'social' },
  mention: { group: 'social' },
  post_mention: { group: 'social' },
  // BB6: to the post author once, when the deadline has passed (job polls.closed). No push per vote (too noisy).
  poll_closed: { group: 'social' },
  // BB5 "Lên kèo": settings group "Kèo". A new "sẽ đi" pushes once per person; taking "Đi" back takes them off the row,
  // so coming back to "Đi" later pushes again (a real change of mind).
  event_invite: { group: 'events' },
  event_rsvp: { group: 'events', onlyNewActor: true },
  event_changed: { group: 'events' },
  event_cancelled: { group: 'events' },
  event_comment: { group: 'events' },
  // 2 hours before the start (job friend-events.remind): useless after the start, so TTL 4 h like the couple reminders.
  event_reminder: { group: 'events', timed: true },
  outing_invite: { group: 'events' },
  outing_added: { group: 'events' },
  outing_changed: { group: 'events' },
  outing_review: { group: 'events' },
  outing_closed: { group: 'events' },
  outing_settlement: { group: 'events' },
  outing_completed: { group: 'events' },
};
