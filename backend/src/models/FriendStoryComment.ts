import { Schema, model, type Document, type Types } from 'mongoose';
import { MAX_COMMENT_BODY } from './StoryComment.js';

/** People named with "@" in one comment (plan/ENGINEERING_WORKFLOW.md, BB8). */
export const MAX_MENTIONS = 10;

/**
 * "@Tên" inside `body`: body.slice(offset, offset + length) is "@" + the person's name at the time of writing.
 * Offsets count UTF-16 code units (JavaScript string indexes) of the trimmed body.
 */
export interface CommentMention {
  userId: Types.ObjectId;
  offset: number;
  length: number;
}

export interface FriendStoryCommentDoc extends Document {
  _id: Types.ObjectId;
  storyId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** Root comment this one answers (one level, like Facebook on phones); null for a root comment. */
  parentId: Types.ObjectId | null;
  body: string;
  mentions: CommentMention[];
  /** Set when 3 different people reported the comment: hidden from everyone but its author until reviewed. */
  hiddenByReportsAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export const mentionSchema = new Schema<CommentMention>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    offset: { type: Number, required: true, min: 0 },
    length: { type: Number, required: true, min: 2 },
  },
  { _id: false },
);

const commentSchema = new Schema<FriendStoryCommentDoc>(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'FriendStory', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'FriendStoryComment', default: null },
    body: { type: String, required: true, maxlength: MAX_COMMENT_BODY },
    mentions: { type: [mentionSchema], default: [] },
    hiddenByReportsAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

commentSchema.index({ storyId: 1, deletedAt: 1, createdAt: 1 });
// Replies of one root comment (BB8): listing and hiding them when the root is deleted.
commentSchema.index({ storyId: 1, parentId: 1, createdAt: 1 });

export const FriendStoryComment = model<FriendStoryCommentDoc>('FriendStoryComment', commentSchema);
