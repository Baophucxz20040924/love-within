import { Schema, model, type Document, type Types } from 'mongoose';

/** "Bucket list chung" (plan/COUPLE_V2_PLAN.md, CP3). Shared list: either member adds, edits, pins, deletes or completes. */

export const BUCKET_CATEGORIES = ['travel', 'food', 'experience', 'learning', 'other'] as const;
export type BucketCategory = (typeof BUCKET_CATEGORIES)[number];

export const BUCKET_CATEGORY_INFO: Record<BucketCategory, { label: string; emoji: string }> = {
  travel: { label: 'Du lịch', emoji: '✈️' },
  food: { label: 'Ăn uống', emoji: '🍜' },
  experience: { label: 'Trải nghiệm', emoji: '🎢' },
  learning: { label: 'Học cùng nhau', emoji: '📚' },
  other: { label: 'Khác', emoji: '✨' },
};

export const BUCKET_STATUSES = ['todo', 'done'] as const;
export type BucketStatus = (typeof BUCKET_STATUSES)[number];

export const MAX_BUCKET_TITLE = 120;
export const MAX_BUCKET_NOTE = 1000;
/** Room for one emoji, including ZWJ sequences (as CP4 events). */
export const MAX_BUCKET_EMOJI = 16;
/** Due dates accepted. */
export const BUCKET_DATE_MIN = '2000-01-01';
export const BUCKET_DATE_MAX = '2100-12-31';

export interface BucketItemDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  title: string;
  emoji: string;
  category: BucketCategory;
  note: string;
  /** "YYYY-MM-DD" (optional deadline). */
  dueOn: string | null;
  pinned: boolean;
  /** The suggestion it was added from (config/bucketIdeas.ts), so the picker shows "Đã thêm". */
  ideaId: string | null;
  status: BucketStatus;
  /** Day it was done ("YYYY-MM-DD", couple timezone); also the story's happenedOn. */
  doneOn: string | null;
  doneBy: Types.ObjectId | null;
  /** When it was marked done (the 24-hour "Đánh dấu chưa làm" window starts here). */
  doneAt: Date | null;
  /** "Cảm nhận" written when marking it done (also the text of the story). */
  doneNote: string;
  storyId: Types.ObjectId | null;
  /** Set once, when the reward is paid; never cleared (reopening keeps it, so an item is rewarded at most once). */
  rewardedAt: Date | null;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  /** Soft delete ("Hoàn tác" restores it). */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const bucketItemSchema = new Schema<BucketItemDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    title: { type: String, required: true, maxlength: MAX_BUCKET_TITLE },
    emoji: { type: String, required: true, maxlength: MAX_BUCKET_EMOJI },
    category: { type: String, enum: BUCKET_CATEGORIES, required: true },
    note: { type: String, default: '', maxlength: MAX_BUCKET_NOTE },
    dueOn: { type: String, default: null },
    pinned: { type: Boolean, default: false },
    ideaId: { type: String, default: null },
    status: { type: String, enum: BUCKET_STATUSES, default: 'todo' },
    doneOn: { type: String, default: null },
    doneBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    doneAt: { type: Date, default: null },
    doneNote: { type: String, default: '', maxlength: MAX_BUCKET_NOTE },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', default: null },
    rewardedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Lists and counts: this couple's items that are not deleted, by status.
bucketItemSchema.index({ coupleId: 1, deletedAt: 1, status: 1 });

export const BucketItem = model<BucketItemDoc>('BucketItem', bucketItemSchema);

/**
 * Rewarded bucket items per couple per day (couple timezone), for the cap of ECONOMY.bucket.maxRewardsPerDay.
 * A conditional $inc on one document per day is race-safe: two completions at the same moment cannot both take the last slot.
 */
export interface BucketRewardDayDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  localDate: string;
  count: number;
  createdAt: Date;
}

const rewardDaySchema = new Schema<BucketRewardDayDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    localDate: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

rewardDaySchema.index({ coupleId: 1, localDate: 1 }, { unique: true });
// Only today's counter matters; a day ends at most ~26 h after its first reward (timezones), so 3 days is plenty.
rewardDaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 86_400 });

export const BucketRewardDay = model<BucketRewardDayDoc>('BucketRewardDay', rewardDaySchema);
