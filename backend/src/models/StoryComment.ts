import { Schema, model, type Document, type Types } from 'mongoose';

export const MAX_COMMENT_BODY = 2000;

export interface StoryCommentDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  storyId: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  deletedAt: Date | null;
  createdAt: Date;
}

const commentSchema = new Schema<StoryCommentDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: MAX_COMMENT_BODY },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

commentSchema.index({ coupleId: 1, storyId: 1, createdAt: 1 });
commentSchema.index({ coupleId: 1, createdAt: -1 });

export const StoryComment = model<StoryCommentDoc>('StoryComment', commentSchema);
