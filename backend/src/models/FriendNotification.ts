import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Friends-space notification types (plan/ENGINEERING_WORKFLOW.md, BB1; comment_reply and mention: BB8; poll_closed: BB6;
 * event_*: BB5 "Lên kèo", entityId = the event).
 */
export const FRIEND_NOTIFICATION_TYPES = [
  'friend_request',
  'friend_accepted',
  'story_reaction',
  'story_comment',
  'invite_joined',
  'comment_reply',
  'mention',
  'post_mention',
  'poll_closed',
  'event_invite',
  'event_rsvp',
  'event_changed',
  'event_cancelled',
  'event_comment',
  'event_reminder',
  'outing_invite',
  'outing_added',
  'outing_changed',
  'outing_review',
  'outing_closed',
  'outing_settlement',
  'outing_completed',
] as const;
export type FriendNotificationType = (typeof FRIEND_NOTIFICATION_TYPES)[number];

/** Outings have their own entity and ACL; never treat these as legacy event types. */
export const OUTING_NOTIFICATION_TYPES: ReadonlySet<FriendNotificationType> = new Set<FriendNotificationType>([
  'outing_invite',
  'outing_added',
  'outing_changed',
  'outing_review',
  'outing_closed',
  'outing_settlement',
  'outing_completed',
]);

/** BB5: entityId is an event. */
export const EVENT_NOTIFICATION_TYPES: ReadonlySet<FriendNotificationType> = new Set<FriendNotificationType>([
  'event_invite',
  'event_rsvp',
  'event_changed',
  'event_cancelled',
  'event_comment',
  'event_reminder',
]);

/**
 * Sent by the server itself (a job), not by a person: the row has no actors. poll_closed goes to the post author when
 * the deadline of their poll has passed; event_reminder 2 hours before an event starts (job friend-events.remind).
 */
export const SYSTEM_NOTIFICATION_TYPES: ReadonlySet<FriendNotificationType> = new Set<FriendNotificationType>(['poll_closed', 'event_reminder']);

/**
 * These collect several people on one row ("Long và 3 người khác…"): per post for reactions and comments, per root
 * comment for replies, per event for "sẽ đi", comments and changes (a second change bumps the same row). The others get
 * one row per event.
 */
export const GROUPED_NOTIFICATION_TYPES: ReadonlySet<FriendNotificationType> = new Set<FriendNotificationType>([
  'story_reaction',
  'story_comment',
  'comment_reply',
  'event_rsvp',
  'event_changed',
  'event_comment',
]);

export const NOTIFICATION_TTL_DAYS = 90;

export interface FriendNotificationDoc extends Document {
  _id: Types.ObjectId;
  /** Recipient. */
  userId: Types.ObjectId;
  type: FriendNotificationType;
  /**
   * Post (story_*, post_mention, poll_closed), friend request (friend_request), root comment (comment_reply), comment with the mention
   * (mention), event (event_*) or null.
   */
  entityId: Types.ObjectId | null;
  /** `${type}:${entityId}` for grouped types and insert-once post mentions, null otherwise. */
  groupKey: string | null;
  /** Everyone who acted, without duplicates (for "và N người khác"). Empty for SYSTEM_NOTIFICATION_TYPES. */
  actorIds: Types.ObjectId[];
  /** Up to 3, newest first (names and photos shown on the row). */
  recentActorIds: Types.ObjectId[];
  readAt: Date | null;
  createdAt: Date;
  /** Bumped by every new actor: the list is sorted by it and old rows expire on it. */
  updatedAt: Date;
}

// Timestamps are written explicitly: grouped rows are upserted with an update pipeline.
const notificationSchema = new Schema<FriendNotificationDoc>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: FRIEND_NOTIFICATION_TYPES, required: true },
  entityId: { type: Schema.Types.ObjectId, default: null },
  groupKey: { type: String, default: null },
  actorIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  recentActorIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});

notificationSchema.index({ userId: 1, updatedAt: -1, _id: -1 });
notificationSchema.index({ userId: 1, groupKey: 1 }, { unique: true, partialFilterExpression: { groupKey: { $type: 'string' } } });
notificationSchema.index({ entityId: 1 });
notificationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_DAYS * 86_400 });

export const FriendNotification = model<FriendNotificationDoc>('FriendNotification', notificationSchema);
