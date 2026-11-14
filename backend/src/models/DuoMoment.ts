import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * "Khoảnh khắc đôi" (plan/ENGINEERING_WORKFLOW.md, CP6): once a day, at a random time, both members take one photo.
 * Owner decision 7 (10/11/2026): the prompt time is random in 09:00–21:00 couple time; "on time" = posted within 10 minutes
 * of it; posting is possible until 23:59 the same day, after that the day is "Bỏ lỡ" for whoever did not post.
 * The partner's photo is never returned to a member who has not posted that day (moment.service.ts).
 */

/** The prompt time is drawn in this window, couple timezone. */
export const MOMENT_WINDOW_FROM = '09:00';
export const MOMENT_WINDOW_TO = '21:00';
/** Posted within this many minutes of the prompt = on time; later = "Muộn …". */
export const MOMENT_ON_TIME_MIN = 10;
/** The job announces a prompt at most this late (server down, missed ticks); later ones are left silent. */
export const MOMENT_NOTIFY_MAX_LATE_MIN = 30;
export const MAX_MOMENT_CAPTION = 100;

export interface MomentPost {
  userId: Types.ObjectId;
  /** couples/<coupleId>/moments/<YYYY-MM>/<uuid>.<ext> */
  key: string;
  width: number;
  height: number;
  caption: string;
  postedAt: Date;
  /** Minutes between the prompt and the post when later than MOMENT_ON_TIME_MIN, else 0 (server clock). */
  lateMin: number;
}

export interface DuoMomentDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  /** "YYYY-MM-DD", couple timezone. */
  localDate: string;
  /** Random time of the day's prompt. Never returned to the app before it has passed. */
  promptAt: Date;
  /** Set (atomically) by the job duo-moment.prompt right before it pushes "Đến giờ Khoảnh khắc". */
  notifiedAt: Date | null;
  /** At most one per member (conditional $push). */
  posts: MomentPost[];
  /** The Story post made from both photos ("Đăng lên Story"), once. */
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

const momentSchema = new Schema<DuoMomentDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    localDate: { type: String, required: true },
    promptAt: { type: Date, required: true },
    notifiedAt: { type: Date, default: null },
    posts: { type: [postSchema], default: [] },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', default: null },
  },
  { timestamps: true },
);

// One moment per couple per day: the job and the lazy "today" both upsert on it, so they never make two.
// Also serves today's view, the month calendar (localDate range) and the streak.
momentSchema.index({ coupleId: 1, localDate: 1 }, { unique: true });
// Job: prompts of the last days whose time has come and that were not announced yet.
momentSchema.index({ localDate: 1, notifiedAt: 1, promptAt: 1 });

export const DuoMoment = model<DuoMomentDoc>('DuoMoment', momentSchema);
