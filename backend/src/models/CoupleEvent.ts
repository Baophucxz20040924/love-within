import { Schema, model, type Document, type Types } from 'mongoose';

/** "Đếm ngược sự kiện" (plan/ENGINEERING_WORKFLOW.md, CP4). Either member creates, edits or deletes; no dual approval. */

export const EVENT_KINDS = ['birthday', 'trip', 'meet', 'anniversary', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_REPEATS = ['none', 'yearly'] as const;
export type EventRepeat = (typeof EVENT_REPEATS)[number];

export const MAX_EVENT_TITLE = 80;
export const MAX_EVENT_NOTE = 500;
/** Room for one emoji, including ZWJ sequences such as 👩‍❤️‍👨 (8 UTF-16 units). */
export const MAX_EVENT_EMOJI = 16;
/** Dates accepted for an event (birthdays reach far back). */
export const EVENT_DATE_MIN = '1900-01-01';
export const EVENT_DATE_MAX = '2100-12-31';

export const DEFAULT_EVENT_EMOJI: Record<EventKind, string> = {
  birthday: '🎂',
  trip: '✈️',
  meet: '🤗',
  anniversary: '💞',
  other: '📌',
};

/** Repeat on by default for birthdays and anniversaries. */
export const defaultRepeatFor = (kind: EventKind): EventRepeat => (kind === 'birthday' || kind === 'anniversary' ? 'yearly' : 'none');

export interface CoupleEventDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  title: string;
  emoji: string;
  kind: EventKind;
  /** Whose birthday (a member of the couple); null for other kinds. */
  personId: Types.ObjectId | null;
  /** "YYYY-MM-DD": the day itself, or the first/original day of a yearly event (e.g. the birth date). */
  date: string;
  /** "HH:mm" couple time; null = all day. */
  time: string | null;
  repeat: EventRepeat;
  note: string;
  /** Reminder switch, stored now; the reminder job comes with N2/N4 (wave 3). */
  remind: boolean;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  /** Soft delete. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new Schema<CoupleEventDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    title: { type: String, required: true, maxlength: MAX_EVENT_TITLE },
    emoji: { type: String, required: true, maxlength: MAX_EVENT_EMOJI },
    kind: { type: String, enum: EVENT_KINDS, required: true },
    personId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    date: { type: String, required: true },
    time: { type: String, default: null },
    repeat: { type: String, enum: EVENT_REPEATS, default: 'none' },
    note: { type: String, default: '', maxlength: MAX_EVENT_NOTE },
    remind: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Every read is "this couple's events that are not deleted" (list, Home pulse).
eventSchema.index({ coupleId: 1, deletedAt: 1 });

export const CoupleEvent = model<CoupleEventDoc>('CoupleEvent', eventSchema);
