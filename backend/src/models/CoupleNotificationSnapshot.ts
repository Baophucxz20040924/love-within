import { Schema, model, type Document, type Types } from 'mongoose';

/** Server-observed page IDs, not a client timestamp: delayed inserts cannot be acknowledged accidentally. */
export interface CoupleNotificationSnapshotDoc extends Document {
  userId: Types.ObjectId;
  coupleId: Types.ObjectId;
  token: string;
  notificationIds: Types.ObjectId[];
  expiresAt: Date;
}
const schema = new Schema<CoupleNotificationSnapshotDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  coupleId: { type: Schema.Types.ObjectId, required: true },
  token: { type: String, required: true, maxlength: 64 },
  notificationIds: { type: [Schema.Types.ObjectId], required: true },
  expiresAt: { type: Date, required: true },
});
schema.index({ userId: 1, coupleId: 1, token: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CoupleNotificationSnapshot = model<CoupleNotificationSnapshotDoc>('CoupleNotificationSnapshot', schema);
