import { Schema, model, type Document, type Types } from 'mongoose';

export const FINANCE_VISIBILITIES = ['private', 'partner'] as const;
export type FinanceVisibility = (typeof FINANCE_VISIBILITIES)[number];

export const MAX_FRIENDS_BIO = 160;

/**
 * Web Push settings (plan/PLATFORM_PLAN.md, N4), per account (every device of the user). One switch per group of
 * config/notificationTypes.ts; `preview` off shows only "Bạn có thông báo mới" on the lock screen (the friends space
 * starts hidden). Quiet hours ("HH:mm", users.timezone) hold back pushes only; in-app notifications stay.
 */
export interface PushSettings {
  couple: { approvals: boolean; stories: boolean; reminders: boolean; nudges: boolean; moments: boolean; preview: boolean };
  friends: { social: boolean; events: boolean; messages: boolean; preview: boolean };
  quiet: { enabled: boolean; from: string; to: string };
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  couple: { approvals: true, stories: true, reminders: true, nudges: true, moments: true, preview: true },
  friends: { social: true, events: true, messages: true, preview: false },
  quiet: { enabled: true, from: '23:00', to: '07:00' },
};

export interface UserDoc extends Document {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  displayName: string;
  coupleId: Types.ObjectId | null;
  timezone: string;
  /** Last time the user opened the Story feed; drives the "new posts/comments" badge. */
  storiesSeenAt: Date | null;
  /** Last time the user opened the Market tab; drives the "answered requests / new items" badge. */
  marketSeenAt: Date | null;
  /** Who may see this user's bank cash flow: only themselves, or also their partner. */
  financeVisibility: FinanceVisibility;
  /** When the user agreed to send their cash flow to the AI assistant (beeknoee). null = not agreed. */
  aiFinanceConsentAt: Date | null;
  /**
   * First time the user entered the hidden friends space ("Hội bạn bè"). null = never: the user is
   * invisible there (not searchable, cannot receive friend requests) and the friends API answers 403.
   */
  friendsJoinedAt: Date | null;
  /** displayName lowercased without Vietnamese diacritics ("Thu Hà" → "thu ha"), for friend search. */
  friendsSearchName: string | null;
  /** S3 key of the profile photo (avatars/<userId>/…), shared by both spaces. null = initial-letter avatar. */
  avatarKey: string | null;
  /** Short bio on the friends-space profile page. */
  friendsBio: string;
  /** Last time the user opened the friends notifications page; unseen rows after it make the badge. */
  friendsNotifSeenAt: Date | null;
  /** Web Push switches (N4). Older accounts may miss fields: read through resolvePushSettings(). */
  pushSettings: PushSettings;
  createdAt: Date;
  updatedAt: Date;
}

const bool = (value: boolean) => ({ type: Boolean, default: value });
const d = DEFAULT_PUSH_SETTINGS;

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', default: null },
    timezone: { type: String, default: 'Asia/Ho_Chi_Minh' },
    storiesSeenAt: { type: Date, default: null },
    marketSeenAt: { type: Date, default: null },
    financeVisibility: { type: String, enum: FINANCE_VISIBILITIES, default: 'private' },
    aiFinanceConsentAt: { type: Date, default: null },
    friendsJoinedAt: { type: Date, default: null },
    friendsSearchName: { type: String, default: null },
    avatarKey: { type: String, default: null },
    friendsBio: { type: String, default: '', maxlength: MAX_FRIENDS_BIO },
    friendsNotifSeenAt: { type: Date, default: null },
    pushSettings: {
      couple: {
        approvals: bool(d.couple.approvals),
        stories: bool(d.couple.stories),
        reminders: bool(d.couple.reminders),
        nudges: bool(d.couple.nudges),
        moments: bool(d.couple.moments),
        preview: bool(d.couple.preview),
      },
      friends: {
        social: bool(d.friends.social),
        events: bool(d.friends.events),
        messages: bool(d.friends.messages),
        preview: bool(d.friends.preview),
      },
      quiet: {
        enabled: bool(d.quiet.enabled),
        from: { type: String, default: d.quiet.from },
        to: { type: String, default: d.quiet.to },
      },
    },
  },
  { timestamps: true },
);

export const User = model<UserDoc>('User', userSchema);
