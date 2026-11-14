import { Schema, model, type Document, type Types } from 'mongoose';

/** "Xóa" on a friend suggestion (plan/ENGINEERING_WORKFLOW.md, BB7): that person is not suggested again until `until`. */
export const SUGGESTION_DISMISS_DAYS = 90;

export interface FriendSuggestionDismissalDoc extends Document {
  _id: Types.ObjectId;
  /** Who dismissed. */
  userId: Types.ObjectId;
  /** Who is no longer suggested to them. */
  dismissedId: Types.ObjectId;
  /** Dismissed at + 90 days. The row expires here (TTL); reads also check it, since the TTL monitor runs about once a minute. */
  until: Date;
  createdAt: Date;
}

const dismissalSchema = new Schema<FriendSuggestionDismissalDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dismissedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    until: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One row per pair: dismissing again only moves `until`.
dismissalSchema.index({ userId: 1, dismissedId: 1 }, { unique: true });
dismissalSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

export const FriendSuggestionDismissal = model<FriendSuggestionDismissalDoc>('FriendSuggestionDismissal', dismissalSchema);
