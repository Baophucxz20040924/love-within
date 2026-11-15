import { Schema, model, type Document, type Types } from 'mongoose';

/** Never change the interpretation of photos from the original/v2 schedules. */
export const LEGACY_MOMENT_ON_TIME_MIN = 10;
export const MOMENT_ON_TIME_MIN = 30;
export const MOMENT_SCHEDULE_VERSION = 3;
/** Inclusive start-minute window, in the timezone snapshotted on the day. */
export const MOMENT_WINDOW_FROM = '09:00';
export const MOMENT_WINDOW_TO = '21:00';
export const MAX_MOMENT_CAPTION = 100;

export interface MomentPost {
  userId: Types.ObjectId;
  /** couples/<coupleId>/moments/<localDate>/<sessionId>/<userId>/<uuid>.<ext> */
  key: string;
  width: number;
  height: number;
  caption: string;
  postedAt: Date;
  /** v3: rounded-up minutes after rewardEndsAt (at least 1 if late). Historical values are retained. */
  lateMin: number;
}

export interface MomentSession {
  id: string;
  promptAt: Date;
  /** Present on v3; older sessions retain their original ten-minute window. */
  rewardEndsAt?: Date;
  closesAt: Date;
  notifiedAt: Date | null;
  posts: MomentPost[];
  storyId: Types.ObjectId | null;
}

export interface DuoMomentDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  localDate: string;
  scheduleVersion?: number;
  timezone?: string;
  sessions?: MomentSession[];
  // Legacy fields remain readable, never rewritten or reopened.
  promptAt: Date;
  notifiedAt: Date | null;
  posts: MomentPost[];
  storyId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const postSchema = new Schema<MomentPost>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    caption: { type: String, default: '', maxlength: MAX_MOMENT_CAPTION },
    postedAt: { type: Date, required: true },
    lateMin: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);
const sessionSchema = new Schema<MomentSession>(
  {
    id: { type: String, required: true },
    promptAt: { type: Date, required: true },
    rewardEndsAt: Date,
    closesAt: { type: Date, required: true },
    notifiedAt: { type: Date, default: null },
    posts: { type: [postSchema], default: [] },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', default: null },
  },
  { _id: false },
);
const momentSchema = new Schema<DuoMomentDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    localDate: { type: String, required: true },
    scheduleVersion: Number,
    timezone: String,
    // undefined is important: old documents must remain identifiable as legacy.
    sessions: { type: [sessionSchema], default: undefined, validate: (sessions: MomentSession[]) => sessions.length <= 3 },
    promptAt: Date,
    notifiedAt: { type: Date, default: null },
    posts: { type: [postSchema], default: [] },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', default: null },
  },
  { timestamps: true },
);
momentSchema.index({ coupleId: 1, localDate: 1 }, { unique: true });
// Retain the legacy index; no destructive index migration is needed.
momentSchema.index({ localDate: 1, notifiedAt: 1, promptAt: 1 });
momentSchema.index({ localDate: 1, 'sessions.promptAt': 1 });
export const DuoMoment = model<DuoMomentDoc>('DuoMoment', momentSchema);

/** Maximum distinct members in one session, never a sum across sessions. Also supports legacy quests. */
export function momentProgress(day: Pick<DuoMomentDoc, 'sessions' | 'posts'> | null, memberIds: Types.ObjectId[]): number {
  const members = new Set(memberIds.map(String));
  const groups = day?.sessions?.map((s) => s.posts) ?? [day?.posts ?? []];
  return Math.max(0, ...groups.map((posts) => new Set(posts.filter((p) => members.has(String(p.userId))).map((p) => String(p.userId))).size));
}

/** Reward progress is separate from streak completion. Old days retain their original quest policy. */
export function momentRewardProgress(day: Pick<DuoMomentDoc, 'scheduleVersion' | 'sessions' | 'posts'> | null, memberIds: Types.ObjectId[]): number {
  if (day?.scheduleVersion !== MOMENT_SCHEDULE_VERSION) return momentProgress(day, memberIds);
  const members = new Set(memberIds.map(String));
  return Math.max(0, ...(day.sessions ?? []).map((s) => new Set(s.posts.filter((p) =>
    members.has(String(p.userId)) && s.rewardEndsAt && p.postedAt >= s.promptAt && p.postedAt < s.rewardEndsAt,
  ).map((p) => String(p.userId))).size));
}
