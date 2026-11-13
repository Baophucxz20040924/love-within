import { Schema, model, type Document, type Types } from 'mongoose';
import { MAX_STORY_BODY, REACTION_TYPES, type ReactionType, type StoryPhoto } from './Story.js';

/** Poll in a post (BB6, plan/FRIENDS_V2_PLAN.md): 2–4 options of ≤ 80 characters; the post body is the question. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const MAX_POLL_OPTION = 80;
/** Deadline choices in days (0 = no deadline). */
export const POLL_DURATION_DAYS = [0, 1, 3, 7] as const;
export type PollDurationDays = (typeof POLL_DURATION_DAYS)[number];

export interface PollOption {
  /** Random short id: a client holding an old poll cannot vote for a different text after an edit. */
  id: string;
  text: string;
}

export interface FriendPoll {
  options: PollOption[];
  multi: boolean;
  /** null = never closes. */
  endsAt: Date | null;
  /** userId → chosen option ids (one for a single-choice poll). Counts are derived from it, so they cannot drift. */
  votes: Map<string, string[]>;
  /** Set once by the polls.closed job when it told the author (atomic "notify once" flag). */
  closedNotifiedAt: Date | null;
}

/**
 * Post in the hidden friends space ("Hội bạn bè"). Not scoped by couple: the author and the author's
 * friends see it (checked at query time, so unfriending hides old posts at once).
 */
export interface FriendStoryDoc extends Document {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  /** key: friends/<authorId>/stories/<YYYY-MM>/<uuid>.<ext> */
  photos: StoryPhoto[];
  /** userId → reaction (any friend of the author). */
  reactions: Map<string, ReactionType>;
  commentCount: number;
  /** BB6; null for a post without a poll. */
  poll: FriendPoll | null;
  editedAt: Date | null;
  /** Set when 3 different people reported the post: hidden from everyone but the author until reviewed. */
  hiddenByReportsAt: Date | null;
  /** Soft delete: hidden from the app, recoverable by an admin. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const photoSchema = new Schema<StoryPhoto>(
  {
    key: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const pollOptionSchema = new Schema<PollOption>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, maxlength: MAX_POLL_OPTION },
  },
  { _id: false },
);

const pollSchema = new Schema<FriendPoll>(
  {
    options: { type: [pollOptionSchema], required: true },
    multi: { type: Boolean, default: false },
    endsAt: { type: Date, default: null },
    votes: { type: Map, of: [String], default: () => new Map() },
    closedNotifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const friendStorySchema = new Schema<FriendStoryDoc>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '', maxlength: MAX_STORY_BODY },
    photos: { type: [photoSchema], default: [] },
    reactions: { type: Map, of: { type: String, enum: REACTION_TYPES }, default: () => new Map() },
    commentCount: { type: Number, default: 0, min: 0 },
    poll: { type: pollSchema, default: null },
    editedAt: { type: Date, default: null },
    hiddenByReportsAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Feed: posts of me + my friends ($in authorId), newest first, cursor = _id.
friendStorySchema.index({ authorId: 1, deletedAt: 1, _id: -1 });
// Job polls.closed: polls with a deadline that have not been announced yet. Only polls with a deadline are indexed.
friendStorySchema.index(
  { 'poll.closedNotifiedAt': 1, 'poll.endsAt': 1 },
  { partialFilterExpression: { 'poll.endsAt': { $type: 'date' } } },
);

export const FriendStory = model<FriendStoryDoc>('FriendStory', friendStorySchema);
