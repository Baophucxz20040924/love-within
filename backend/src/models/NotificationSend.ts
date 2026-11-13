import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * "Send once" keys of the background jobs (plan/PLATFORM_PLAN.md, N2). Used for repeating or time-dependent work whose
 * record cannot carry a flag: a yearly event is reminded every year, a meetup can change its time. A job inserts the key
 * before it sends; the unique index turns a second insert (another run, a restarted server) into a no-op.
 * Key format: `<feature>:<id>:<occurrence>:<slot>`, e.g. `cp-event:<eventId>:2027-02-14:d1`. Keys hold ids and dates only,
 * never private text. Kept 120 days (TTL), longer than any reminder window.
 */

export const NOTIFICATION_SEND_TTL_DAYS = 120;
export const MAX_NOTIFICATION_SEND_KEY = 200;

export interface NotificationSendDoc extends Document {
  _id: Types.ObjectId;
  key: string;
  sentAt: Date;
}

const notificationSendSchema = new Schema<NotificationSendDoc>({
  key: { type: String, required: true, maxlength: MAX_NOTIFICATION_SEND_KEY },
  sentAt: { type: Date, required: true },
});

notificationSendSchema.index({ key: 1 }, { unique: true });
notificationSendSchema.index({ sentAt: 1 }, { expireAfterSeconds: NOTIFICATION_SEND_TTL_DAYS * 86_400 });

export const NotificationSend = model<NotificationSendDoc>('NotificationSend', notificationSendSchema);
