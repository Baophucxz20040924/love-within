import { Schema, model, type Document, type Types } from 'mongoose';
import { MOODS, type Mood } from './Story.js';

/**
 * "Cảm xúc hôm nay" (plan/ENGINEERING_WORKFLOW.md, CP5): one mood per member per day (couple timezone); setting it again
 * overwrites (last write wins). Same keys as the story mood (`MOODS` in models/Story.ts); the frontend owns emoji + label.
 */

export const MAX_MOOD_NOTE = 140;
/** History window of GET /api/moods?days= (default 30). */
export const MAX_MOOD_DAYS = 90;
export const DEFAULT_MOOD_DAYS = 30;

export { MOODS, type Mood };

export interface CoupleMoodDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  userId: Types.ObjectId;
  /** "YYYY-MM-DD" in the couple timezone. */
  localDate: string;
  mood: Mood;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

const moodSchema = new Schema<CoupleMoodDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    localDate: { type: String, required: true },
    mood: { type: String, enum: MOODS, required: true },
    note: { type: String, default: '', maxlength: MAX_MOOD_NOTE },
  },
  { timestamps: true },
);

// One per member per day (the upsert relies on it). Also serves today's moods (pulse) and the history
// ({ coupleId, userId: { $in: members }, localDate range }).
moodSchema.index({ coupleId: 1, userId: 1, localDate: 1 }, { unique: true });

export const CoupleMood = model<CoupleMoodDoc>('CoupleMood', moodSchema);
