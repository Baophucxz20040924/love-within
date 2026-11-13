import { Schema, model, type Document, type Types } from 'mongoose';

/** Facebook-style reactions. */
export const REACTION_TYPES = ['like', 'love', 'care', 'haha', 'wow', 'sad'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

/** "đang cảm thấy …" — keys only; the frontend owns emoji + label. */
export const MOODS = ['happy', 'loved', 'in_love', 'grateful', 'excited', 'peaceful', 'missing', 'tired', 'sad'] as const;
export type Mood = (typeof MOODS)[number];

export const MAX_STORY_PHOTOS = 10;
export const MAX_STORY_BODY = 20_000;

export interface StoryPhoto {
  key: string; // couples/<coupleId>/stories/<YYYY-MM>/<uuid>.<ext>
  width: number;
  height: number;
}

export interface StoryDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  mood: Mood | null;
  /** Day the memory happened ("YYYY-MM-DD", couple timezone). Defaults to the posting day. */
  happenedOn: string;
  photos: StoryPhoto[];
  /** userId → reaction. At most two entries (the couple). */
  reactions: Map<string, ReactionType>;
  commentCount: number;
  /** Set when the author edits; the UI shows "Đã chỉnh sửa". */
  editedAt: Date | null;
  /** Soft delete: hidden from the app, recoverable by an admin. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const photoSchema = new Schema<StoryPhoto>(
  {
    key: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const storySchema = new Schema<StoryDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '', maxlength: MAX_STORY_BODY },
    mood: { type: String, enum: [...MOODS, null], default: null },
    happenedOn: { type: String, required: true },
    photos: { type: [photoSchema], default: [] },
    reactions: { type: Map, of: { type: String, enum: REACTION_TYPES }, default: () => new Map() },
    commentCount: { type: Number, default: 0, min: 0 },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Feed: newest first, cursor = _id.
storySchema.index({ coupleId: 1, deletedAt: 1, _id: -1 });

export const Story = model<StoryDoc>('Story', storySchema);
