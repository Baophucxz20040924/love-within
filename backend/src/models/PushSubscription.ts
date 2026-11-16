import { Schema, model, type Document, type Types } from 'mongoose';

export const PUSH_SPACES = ['couple', 'friends'] as const;
export type PushSpace = (typeof PUSH_SPACES)[number];

/**
 * One browser/device that receives Web Push (plan/OPERATIONS.md, N4). An endpoint belongs to one user account across
 * both spaces. Turning notifications on as another user transfers the endpoint. Logging out deletes it.
 * Legacy space values are retained on existing rows but never scope subscription reads or delivery.
 */
export interface PushSubscriptionDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Legacy metadata only; not written for new subscriptions. */
  space?: PushSpace;
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
    space: { type: String, enum: PUSH_SPACES },
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
// Keep the legacy index; rollout must not drop indexes or rewrite existing subscriptions.
pushSubscriptionSchema.index({ userId: 1, space: 1, updatedAt: -1 });
pushSubscriptionSchema.index({ userId: 1, updatedAt: -1 });

export const PushSubscription = model<PushSubscriptionDoc>('PushSubscription', pushSubscriptionSchema);
