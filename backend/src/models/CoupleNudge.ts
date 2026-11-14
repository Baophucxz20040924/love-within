import { Schema, model, type Document, type Types } from 'mongoose';

/** "Nhớ bạn" một chạm (plan/ENGINEERING_WORKFLOW.md, CP5): one tap on the heart in the Home Hero. */

export const NUDGE_KINDS = ['miss', 'hug', 'kiss', 'thinking'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

/** Server-side wait between two nudges of the same person. */
export const NUDGE_COOLDOWN_SEC = 30;
/** Nudges one person may send per day (couple timezone). */
export const MAX_NUDGES_PER_DAY = 50;
/** Rows are only needed for "today" counts and the last one; kept 60 days (TTL). */
export const NUDGE_TTL_DAYS = 60;

export interface CoupleNudgeDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  fromUserId: Types.ObjectId;
  toUserId: Types.ObjectId;
  kind: NudgeKind;
  createdAt: Date;
}

const nudgeSchema = new Schema<CoupleNudgeDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: NUDGE_KINDS, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Received today / last received (pulse) and, since a couple has two members, sent by the partner of `toUserId`
// (cooldown and daily limit): every read is { coupleId, toUserId, createdAt range }.
nudgeSchema.index({ coupleId: 1, toUserId: 1, createdAt: -1 });
nudgeSchema.index({ createdAt: 1 }, { expireAfterSeconds: NUDGE_TTL_DAYS * 86_400 });

export const CoupleNudge = model<CoupleNudgeDoc>('CoupleNudge', nudgeSchema);
