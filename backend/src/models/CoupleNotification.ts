import { Schema, model, type Document, type Types } from 'mongoose';
import { COUPLE_NOTIFICATION_TYPES, type CoupleNotificationType } from '../config/notificationTypes.js';

/** References only. Content and permission to open the destination come from its existing API. */
export type CoupleNotificationTarget =
  | { kind: 'approval'; category: 'water' | 'proposal' | 'redemption'; id: string }
  | { kind: 'story'; id: string; commentId?: string }
  | { kind: 'question' | 'letter' | 'event' | 'nudge' | 'bucket' | 'savings'; id: string }
  | { kind: 'moment'; dayId: string; localDate: string; sessionId: string };

export interface CoupleNotificationDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  coupleId: Types.ObjectId;
  type: CoupleNotificationType;
  actorId: Types.ObjectId | null;
  entityId: Types.ObjectId | null;
  eventKey: string;
  target: CoupleNotificationTarget;
  createdAt: Date;
  readAt: Date | null;
  seenAt: Date | null;
}

const targetSchema = new Schema({
  kind: { type: String, required: true, enum: ['approval', 'story', 'question', 'letter', 'event', 'nudge', 'bucket', 'savings', 'moment'] },
  category: { type: String, enum: ['water', 'proposal', 'redemption'] },
  id: { type: String, maxlength: 100 },
  commentId: { type: String, maxlength: 24 },
  dayId: { type: String, maxlength: 24 },
  localDate: { type: String, maxlength: 10 },
  sessionId: { type: String, maxlength: 36 },
}, { _id: false });

// Insert-only event rows: retries never move createdAt or erase seen/read state.
const schema = new Schema<CoupleNotificationDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  coupleId: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, enum: COUPLE_NOTIFICATION_TYPES, required: true },
  actorId: { type: Schema.Types.ObjectId, default: null },
  entityId: { type: Schema.Types.ObjectId, default: null },
  eventKey: { type: String, required: true, maxlength: 240 },
  target: { type: targetSchema, required: true },
  createdAt: { type: Date, required: true },
  readAt: { type: Date, default: null },
  seenAt: { type: Date, default: null },
});
schema.index({ userId: 1, coupleId: 1, eventKey: 1 }, { unique: true });
schema.index({ userId: 1, coupleId: 1, createdAt: -1, _id: -1 });
schema.index({ userId: 1, coupleId: 1, seenAt: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
export const CoupleNotification = model<CoupleNotificationDoc>('CoupleNotification', schema);
