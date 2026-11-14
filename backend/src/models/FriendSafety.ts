import { Schema, model, type Document, type Types } from 'mongoose';

/** Friends space: blocks, reports and per-user hidden posts (plan/ENGINEERING_WORKFLOW.md, BB2). */

// ── Blocks ───────────────────────────────────────────────

export interface FriendBlockDoc extends Document {
  _id: Types.ObjectId;
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt: Date;
}

const blockSchema = new Schema<FriendBlockDoc>(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });

export const FriendBlock = model<FriendBlockDoc>('FriendBlock', blockSchema);

// ── Reports ──────────────────────────────────────────────

/** event / event_comment: "Lên kèo" (BB5) and its discussion. */
export const REPORT_TARGETS = ['user', 'story', 'comment', 'event', 'event_comment'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_REASONS = ['spam', 'harassment', 'sensitive', 'violence', 'fake', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['open', 'kept', 'removed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Different people reporting the same post or comment before it is hidden pending review. */
export const AUTO_HIDE_REPORTS = 3;

export interface FriendReportDoc extends Document {
  _id: Types.ObjectId;
  reporterId: Types.ObjectId;
  targetType: ReportTarget;
  targetId: Types.ObjectId;
  /** Author of the post/comment, or the reported user. */
  targetOwnerId: Types.ObjectId;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  resolvedAt: Date | null;
  createdAt: Date;
}

const reportSchema = new Schema<FriendReportDoc>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: REPORT_TARGETS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    targetOwnerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: REPORT_STATUSES, default: 'open' },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One open report per person per target; after a review the same person may report again.
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
reportSchema.index({ targetType: 1, targetId: 1, status: 1 });
reportSchema.index({ status: 1, createdAt: -1 });

export const FriendReport = model<FriendReportDoc>('FriendReport', reportSchema);

// ── Posts a user hid from their own feed ─────────────────

export interface FriendHiddenStoryDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storyId: Types.ObjectId;
  createdAt: Date;
}

const hiddenSchema = new Schema<FriendHiddenStoryDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    storyId: { type: Schema.Types.ObjectId, ref: 'FriendStory', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

hiddenSchema.index({ userId: 1, storyId: 1 }, { unique: true });

export const FriendHiddenStory = model<FriendHiddenStoryDoc>('FriendHiddenStory', hiddenSchema);
