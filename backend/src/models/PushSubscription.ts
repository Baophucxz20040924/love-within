import { Schema, model, type Document, type Types } from 'mongoose';

export const PUSH_SPACES = ['couple', 'friends'] as const;
export type PushSpace = (typeof PUSH_SPACES)[number];

/**
 * One browser/device that receives Web Push (plan/OPERATIONS.md, N4). A device (endpoint) belongs to one user and one
 * space at a time: the space of the session that turned notifications on. Turning them on in the other space, or as
 * another user, moves the endpoint there. Logging out deletes it.
 */
export interface PushSubscriptionDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  space: PushSpace;
  /** Push service URL of the device; a capability, never logged or returned. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Short device label, e.g. "iPhone · Safari". */
  userAgent: string;
  lastSuccessAt: Date | null;
  /** Failed sends in a row (not 404/410); deleted at 5. */
  failCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new Schema<PushSubscriptionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    space: { type: String, enum: PUSH_SPACES, required: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: '' },
    lastSuccessAt: { type: Date, default: null },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

pushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
pushSubscriptionSchema.index({ userId: 1, space: 1, updatedAt: -1 });

export const PushSubscription = model<PushSubscriptionDoc>('PushSubscription', pushSubscriptionSchema);
