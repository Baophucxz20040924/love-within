import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * "Thư hẹn giờ" (plan/COUPLE_V2_PLAN.md, CP2): a letter to the partner that opens only from 00:00 of a chosen day
 * (couple timezone). Before that the recipient sees the envelope only: never the title, body or photos.
 */

export const MAX_LETTER_TITLE = 80;
export const MAX_LETTER_BODY = 20_000;
export const MAX_LETTER_PHOTOS = 4;
/** Latest open date: the same day this many years from today (couple timezone). */
export const MAX_LETTER_YEARS = 20;

export interface LetterPhoto {
  key: string; // couples/<coupleId>/letters/<YYYY-MM>/<uuid>.<ext>
  width: number;
  height: number;
}

export interface CoupleLetterDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** Always the other member. */
  recipientId: Types.ObjectId;
  /** Optional ("" = no title). */
  title: string;
  body: string;
  photos: LetterPhoto[];
  /** "YYYY-MM-DD" in the couple timezone. */
  openOn: string;
  /** 00:00 of `openOn` in the couple timezone, computed on save. The server clock is compared with it. */
  openAt: Date;
  /** First open by the recipient (written once). After it the letter can no longer be edited or deleted. */
  openedAt: Date | null;
  /**
   * Set by the wave-3 job `letters.ready` (N2) when it pushes "Có một lá thư … đang chờ bạn mở" (N4). Reset to null when
   * the author moves the open date, so the new date is announced again. The job picks openAt ≤ now, readyNotifiedAt null,
   * openedAt null, deletedAt null.
   */
  readyNotifiedAt: Date | null;
  /** Set when the author changes the letter. */
  editedAt: Date | null;
  /** Soft delete by the author (only before the first open). */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const photoSchema = new Schema<LetterPhoto>(
  {
    key: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const letterSchema = new Schema<CoupleLetterDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: '', maxlength: MAX_LETTER_TITLE },
    body: { type: String, required: true, maxlength: MAX_LETTER_BODY },
    photos: { type: [photoSchema], default: [] },
    openOn: { type: String, required: true },
    openAt: { type: Date, required: true },
    openedAt: { type: Date, default: null },
    readyNotifiedAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// "Thư cho bạn" and the Home pulse (openable now / next to open).
letterSchema.index({ coupleId: 1, recipientId: 1, openAt: 1 });
// "Thư bạn đã gửi", newest first.
letterSchema.index({ coupleId: 1, authorId: 1, createdAt: -1 });
// Wave-3 job letters.ready: letters whose time has come and that were not announced yet.
letterSchema.index({ readyNotifiedAt: 1, openAt: 1 });

export const CoupleLetter = model<CoupleLetterDoc>('CoupleLetter', letterSchema);
