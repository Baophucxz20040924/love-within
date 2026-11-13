import { Schema, model, type Document, type Types } from 'mongoose';
import { MAX_COMMENT_BODY } from './StoryComment.js';

/** "Lên kèo" in the friends space (BB5, plan/FRIENDS_V2_PLAN.md). Limits from the plan. */
export const MAX_EVENT_TITLE = 100;
export const MAX_EVENT_PLACE = 200;
export const MAX_EVENT_DESCRIPTION = 2000;
export const MAX_EVENT_MAP_URL = 500;
/** People invited to one event (the creator not counted). */
export const MAX_EVENT_INVITEES = 100;
/** No end time: the event counts as over ("Đã qua") this long after it started. */
export const EVENT_DEFAULT_LENGTH_MS = 6 * 3_600_000;
/** Sanity bounds (not in the plan): start at most 2 years ahead, an event lasts at most 30 days. */
export const EVENT_MAX_AHEAD_MS = 2 * 366 * 86_400_000;
export const EVENT_MAX_LENGTH_MS = 30 * 86_400_000;

export const RSVP_STATUSES = ['going', 'maybe', 'declined'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const EVENT_STATUSES = ['active', 'cancelled'] as const;
export type FriendEventStatus = (typeof EVENT_STATUSES)[number];

export interface EventCover {
  /** friends/<creatorId>/events/<YYYY-MM>/<uuid>.<ext> */
  key: string;
  width: number;
  height: number;
}

/**
 * A meetup. Seen by its creator and the people invited, while they are still friends of the creator (checked at read
 * time, so unfriending or blocking the creator removes access at once). Times are stored in UTC.
 */
export interface FriendEventDoc extends Document {
  _id: Types.ObjectId;
  creatorId: Types.ObjectId;
  title: string;
  startAt: Date;
  endAt: Date | null;
  /** endAt, or startAt + 6 h: from then on the event is "Đã qua" (lists and RSVP use it). Kept in step by the service. */
  pastAt: Date;
  place: string;
  /** https only. */
  mapUrl: string | null;
  description: string;
  cover: EventCover | null;
  /** Friends of the creator invited by the creator (≤ 100, never the creator). */
  inviteeIds: Types.ObjectId[];
  /** userId → answer. Invitees without an entry have not answered yet. The creator is always "going". */
  rsvps: Map<string, RsvpStatus>;
  status: FriendEventStatus;
  cancelledAt: Date | null;
  commentCount: number;
  editedAt: Date | null;
  /** Set when 3 different people reported the event: hidden from everyone but the creator until reviewed. */
  hiddenByReportsAt: Date | null;
  /** Soft delete (creator, or `npm run reports -- resolve --remove`). */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const coverSchema = new Schema<EventCover>(
  {
    key: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const friendEventSchema = new Schema<FriendEventDoc>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, maxlength: MAX_EVENT_TITLE },
    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },
    pastAt: { type: Date, required: true },
    place: { type: String, default: '', maxlength: MAX_EVENT_PLACE },
    mapUrl: { type: String, default: null, maxlength: MAX_EVENT_MAP_URL },
    description: { type: String, default: '', maxlength: MAX_EVENT_DESCRIPTION },
    cover: { type: coverSchema, default: null },
    inviteeIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    rsvps: { type: Map, of: { type: String, enum: RSVP_STATUSES }, default: () => new Map() },
    status: { type: String, enum: EVENT_STATUSES, default: 'active' },
    cancelledAt: { type: Date, default: null },
    commentCount: { type: Number, default: 0, min: 0 },
    editedAt: { type: Date, default: null },
    hiddenByReportsAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Events I am invited to, and events I created (lists, by start time).
friendEventSchema.index({ inviteeIds: 1, startAt: 1 });
friendEventSchema.index({ creatorId: 1, startAt: 1 });
// Job friend-events.remind: active events starting soon.
friendEventSchema.index({ status: 1, startAt: 1 });

export const FriendEvent = model<FriendEventDoc>('FriendEvent', friendEventSchema);

/** Discussion under an event: same shape as FriendStoryComment (one level of replies), without mentions. */
export interface FriendEventCommentDoc extends Document {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** Root comment this one answers; null for a root comment. */
  parentId: Types.ObjectId | null;
  body: string;
  hiddenByReportsAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

const commentSchema = new Schema<FriendEventCommentDoc>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'FriendEvent', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'FriendEventComment', default: null },
    body: { type: String, required: true, maxlength: MAX_COMMENT_BODY },
    hiddenByReportsAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

commentSchema.index({ eventId: 1, deletedAt: 1, createdAt: 1 });
commentSchema.index({ eventId: 1, parentId: 1, createdAt: 1 });

export const FriendEventComment = model<FriendEventCommentDoc>('FriendEventComment', commentSchema);
