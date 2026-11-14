// Shared API types (mirror backend response shapes).

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

// ── User / couple ────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** Profile photo (both spaces); null = initial-letter avatar. */
  avatarUrl: string | null;
  coupleId: string | null;
  timezone: string;
}

export interface CoupleMember {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface Couple {
  id: string;
  memberIds: string[];
  members: CoupleMember[];
  anniversaryDate: string | null;
  daysInLove: number | null;
  nextMilestone: { days: number; remaining: number } | null;
  lastMilestone: number | null;
  level: number;
  exp: number;
  timezone: string;
}

export interface Me {
  user: User;
  couple: Couple | null;
  wallet: WalletView | null;
  level: number;
  exp: number;
}

export interface PairingInvite {
  id: string;
  fromUserId: string;
  fromDisplayName: string | null;
  toEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  direction: 'sent' | 'received';
}

// ── Proposals (dual approval) ────────────────────────────

export type ProposalKind = 'water_goal' | 'anniversary_date' | 'savings_goal' | 'savings_goal_update';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  createdBy: string;
  approvals: string[];
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  resolvedAt: string | null;
  /** Savings stays pending until its effect has finished; either signer can retry. */
  applicationState?: 'awaiting_approval' | 'retryable' | 'applied';
}

// ── Wallet / ledger ──────────────────────────────────────

export interface WalletView {
  coinBalance: number;
  exp: number;
  level: number;
  levelBaseExp: number;
  nextLevelExp: number | null;
}

export interface LedgerEntry {
  id: string;
  type: 'coin' | 'exp';
  delta: number;
  balanceAfter: number;
  reason: 'checkin' | 'quest' | 'market_purchase' | 'market_refund' | 'bucket_list' | 'admin';
  refId: string | null;
  actorUserId: string;
  createdAt: string;
}

// ── Check-in / quests ────────────────────────────────────

export interface CheckinStatus {
  localDate: string;
  checkedInToday: boolean;
  streak: number;
  partnerCheckedIn: boolean;
}

export interface CheckinResult {
  localDate: string;
  streak: number;
  coinAwarded: number;
  expAwarded: number;
  balance?: number;
  level?: number;
  leveledUp: boolean;
}

export interface Quest {
  key: string;
  title: string;
  description: string;
  type: 'water_goal' | 'checkin' | 'custom_boolean' | 'daily_question' | 'duo_moment';
  coinReward: number;
  expReward: number;
  progress: number;
  target: number;
  status: 'in_progress' | 'completed' | 'rewarded';
  localDate: string;
}

// ── Water ────────────────────────────────────────────────

export type WaterLogStatus = 'pending' | 'approved' | 'rejected';

export interface WaterLogView {
  id: string;
  userId: string;
  amountMl: number;
  source: 'ai' | 'manual';
  hasImage: boolean;
  status: WaterLogStatus;
  reviewedBy: string | null;
  localDate: string;
  createdAt: string;
}

export interface PendingWater extends WaterLogView {
  submitterName: string;
}

export interface WaterToday {
  localDate: string;
  /** Approved ml only. */
  totalMl: number;
  /** My submissions waiting for my partner. */
  pendingMl: number;
  goalMl: number | null;
  goalMet: boolean;
  remainingMl: number | null;
  logs: WaterLogView[];
  pendingGoalProposal: boolean;
}

export interface WaterSubmitResult {
  logId: string;
  amountMl: number;
  status: 'pending';
  totalMl: number;
  pendingMl: number;
  goalMl: number | null;
}

export interface WaterReviewResult {
  logId: string;
  status: 'approved' | 'rejected';
  amountMl: number;
  totalMl: number;
  goalMl: number | null;
  goalMet: boolean;
}

export interface UploadUrlResult {
  uploadUrl: string;
  imageKey: string;
  expiresIn: number;
  maxBytes: number;
}

// ── Market (each member runs a shop of rewards for the other) ──

export interface MarketItem {
  id: string;
  title: string;
  description: string;
  emoji: string;
  priceCoin: number;
  createdBy: string;
  /** I offer this item (only my partner can redeem it; only I can edit it). */
  isMine: boolean;
  status: 'available' | 'archived';
  createdAt: string;
}

/** requested → accepted → fulfilled · declined / cancelled refund the held coins. */
export type RedemptionStatus = 'requested' | 'accepted' | 'fulfilled' | 'declined' | 'cancelled';

export interface Redemption {
  id: string;
  itemId: string;
  itemTitle: string;
  itemEmoji: string;
  priceCoin: number;
  buyerUserId: string;
  sellerUserId: string;
  buyerName: string;
  sellerName: string;
  isBuyer: boolean;
  status: RedemptionStatus;
  responseNote: string | null;
  createdAt: string;
  respondedAt: string | null;
  fulfilledAt: string | null;
}

export interface MarketUnread {
  count: number;
  responded: number;
  newItems: number;
}

// ── Story (Facebook-style) ───────────────────────────────

export type ReactionType = 'like' | 'love' | 'care' | 'haha' | 'wow' | 'sad';
export type Mood = 'happy' | 'loved' | 'in_love' | 'grateful' | 'excited' | 'peaceful' | 'missing' | 'tired' | 'sad';

export interface StoryPhotoView {
  key: string;
  url: string;
  width: number;
  height: number;
}

export interface Story {
  id: string;
  author: { id: string; displayName: string };
  isMine: boolean;
  body: string;
  mood: Mood | null;
  /** YYYY-MM-DD — day the memory happened. */
  happenedOn: string;
  photos: StoryPhotoView[];
  reactions: { mine: ReactionType | null; partner: ReactionType | null };
  commentCount: number;
  createdAt: string;
  /** Non-null → show "Đã chỉnh sửa". */
  editedAt: string | null;
}

export interface StoryPage {
  items: Story[];
  nextCursor: string | null;
  seenAt: string | null;
}

export interface StoryComment {
  id: string;
  author: { id: string; displayName: string };
  isMine: boolean;
  body: string;
  createdAt: string;
}

export interface StoryUnread {
  count: number;
  stories: number;
  comments: number;
}

export interface StoryContentInput {
  body: string;
  mood: Mood | null;
  happenedOn: string | null;
  photos: { key: string; width: number; height: number }[];
}

// ── Daily question (plan/ENGINEERING_WORKFLOW.md, CP1) ─────────

export type QuestionReaction = 'heart' | 'laugh' | 'touched' | 'wow' | 'like';

export interface QuestionAnswer {
  body: string;
  /** The partner's reaction to this answer. */
  reaction: QuestionReaction | null;
  /** Answered after the question's day ("trả lời bù"). */
  late: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DailyQuestion {
  id: string;
  /** YYYY-MM-DD, couple timezone. */
  localDate: string;
  text: string;
  /** Bank category ("Kỷ niệm"…); null for a question written by one of us. */
  category: string | null;
  source: 'bank' | 'partner';
  /** Who wrote it (source "partner"). */
  askedBy: string | null;
  mine: QuestionAnswer | null;
  /** The server only sends `body` and `reaction` (mine, on their answer) once I have answered too. */
  partner: { answered: boolean; late?: boolean; body?: string; reaction?: QuestionReaction | null };
  /** Both answered: no more edits; reactions open. */
  locked: boolean;
}

export interface TodayQuestion extends DailyQuestion {
  /** My "Hỏi người ấy" question sent today, waiting for a later day (only I see it). */
  myAsk: { text: string; createdAt: string } | null;
}

export interface QuestionPage {
  items: DailyQuestion[];
  nextCursor: string | null;
}

export type QuestionState = 'none' | 'partner_answered' | 'mine_answered' | 'both';

// ── Countdown events (plan/ENGINEERING_WORKFLOW.md, CP4) ───────

export type EventKind = 'birthday' | 'trip' | 'meet' | 'anniversary' | 'other';
export type EventRepeat = 'none' | 'yearly';

export interface CoupleEvent {
  /** Stored event id, or "auto-days-100" / "auto-years-2" for a milestone derived from the anniversary date. */
  id: string;
  /** Milestone from the anniversary date: not editable. */
  auto: boolean;
  title: string;
  emoji: string;
  kind: EventKind;
  /** Whose birthday (member id). */
  personId: string | null;
  /** Stored day; for a yearly event the first/original day (e.g. the birth date). */
  date: string;
  /** "HH:mm" couple time; null = all day. */
  time: string | null;
  repeat: EventRepeat;
  note: string;
  remind: boolean;
  /** Next occurrence ("YYYY-MM-DD", couple timezone). */
  nextDate: string;
  /** 0 = today, negative = past. */
  daysLeft: number;
  /** UTC instant of nextDate + time in the couple timezone; null when all day. */
  startsAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EventList {
  upcoming: CoupleEvent[];
  past: CoupleEvent[];
}

export interface EventInput {
  title: string;
  emoji: string;
  kind: EventKind;
  personId: string | null;
  date: string;
  time: string | null;
  repeat: EventRepeat;
  note: string;
  remind: boolean;
}

/** Home card "Sắp tới": the nearest event in the next 30 days. */
export interface PulseNextEvent {
  id: string;
  auto: boolean;
  title: string;
  emoji: string;
  kind: EventKind;
  /** Next occurrence. */
  date: string;
  time: string | null;
  startsAt: string | null;
  daysLeft: number;
  /** Other events in the next 30 days. */
  others: number;
}

/** GET /api/couple/pulse: combined Home data. More fields arrive with later features (recap). */
export interface CouplePulse {
  question: { id: string; state: QuestionState } | null;
  letters: PulseLetters | null;
  nextEvent: PulseNextEvent | null;
  /** CP5: nudges I received today (couple timezone). */
  nudges: PulseNudges | null;
  /** CP5: today's mood of me and of my partner. */
  moods: { mine: MoodView | null; partner: MoodView | null } | null;
  /** CP6: today's duo moment from my side (Home card while open). */
  moment: PulseMoment | null;
  savings: PulseSavings | null;
}

// ── Shared savings (CP7): records only, never transfers money ──
export type SavingsStatus = 'active' | 'reached' | 'closed';
export interface PulseSavings {
  id: string;
  title: string;
  emoji: string;
  totalVnd: number;
  targetVnd: number;
  status: SavingsStatus;
  reachedAt: string | null;
}
export interface SavingsGoal extends PulseSavings {
  dueOn: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  contributions: { userId: string; amountVnd: number }[];
  forecastOn: string | null;
  version: number;
}
export interface SavingsEntry {
  id: string;
  goalId: string;
  userId: string;
  amountVnd: number;
  occurredOn: string;
  note: string;
  source: 'manual' | 'bank';
  createdAt: string;
  isMine: boolean;
}
export type SavingsListStatus = 'all' | 'open' | SavingsStatus;
export interface SavingsListInput {
  status?: SavingsListStatus;
  q?: string;
  limit?: number;
  cursor?: string;
}
export interface SavingsGoalPage {
  items: SavingsGoal[];
  nextCursor: string | null;
}
export interface SavingsDetail {
  goal: SavingsGoal;
  entries: SavingsEntry[];
  nextCursor: string | null;
}
export interface SavingsGoalInput {
  title: string;
  emoji: string;
  targetVnd: number;
  dueOn: string | null;
}
export interface SavingsUpdateInput {
  targetVnd?: number;
  dueOn?: string | null;
  close?: true;
}
export interface SavingsEntryInput {
  /** Generated once per manual entry; retries must keep the same key and payload. */
  operationId: string;
  amountVnd: number;
  occurredOn: string;
  note: string;
}
export interface SavingsSuggestion {
  amountVnd: number;
  currentOutVnd: number;
  previousOutVnd: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  message: string;
}

// ── "Khoảnh khắc đôi" (plan/ENGINEERING_WORKFLOW.md, CP6) ──

/** waiting (before the prompt, time unknown) · open (I can post) · posted (me, not the partner) · both · missed (day over, I did not post). */
export type MomentState = 'waiting' | 'open' | 'posted' | 'both' | 'missed';

export interface PulseMoment {
  state: MomentState;
  /** Prompt + 10 minutes ("đúng giờ" until then); null before the prompt. */
  windowEndsAt: string | null;
  partnerPosted: boolean;
}

export interface MomentPhoto {
  url: string;
  width: number;
  height: number;
  caption: string;
  postedAt: string;
  /** 0 = on time. */
  lateMin: number;
}

export interface MomentDay {
  localDate: string;
  state: MomentState;
  promptAt: string | null;
  windowEndsAt: string | null;
  /** Posting closes here (00:00 of the next day). */
  closesAt: string;
  closed: boolean;
  mine: MomentPhoto | null;
  /** `photo` only once I have posted that day (server rule). */
  partner: { posted: boolean; postedAt: string | null; photo: MomentPhoto | null };
  storyId: string | null;
}

export interface MomentMonth {
  month: string;
  today: string;
  minMonth: string;
  days: MomentDay[];
  streak: { current: number; best: number };
}

export interface MomentStoryResult {
  moment: MomentDay;
  story: Story;
}

// ── "Nhớ bạn" + mood of the day (plan/ENGINEERING_WORKFLOW.md, CP5) ──

export type NudgeKind = 'miss' | 'hug' | 'kiss' | 'thinking';

export interface PulseNudges {
  receivedToday: number;
  lastAt: string | null;
  lastKind: NudgeKind | null;
}

/** POST /api/nudges */
export interface NudgeSent {
  id: string;
  kind: NudgeKind;
  createdAt: string;
  sentToday: number;
  remainingToday: number;
  /** When the next nudge is allowed (30 s later). */
  nextAt: string;
}

export interface MoodView {
  userId: string;
  /** "YYYY-MM-DD", couple timezone. */
  localDate: string;
  mood: Mood;
  note: string;
  updatedAt: string;
}

/** GET /api/moods?days= */
export interface MoodHistory {
  days: number;
  from: string;
  to: string;
  /** Both members, oldest day first. */
  items: MoodView[];
}

// ── Timed letters (plan/ENGINEERING_WORKFLOW.md, CP2) ──────────

export interface LetterPerson {
  id: string;
  displayName: string;
}

/** List item. A letter to me carries no title before its open time, and never a body or photos. */
export interface LetterSummary {
  id: string;
  from: LetterPerson;
  to: LetterPerson;
  isMine: boolean;
  /** "YYYY-MM-DD", couple timezone. */
  openOn: string;
  /** 0 = today, negative = past. */
  daysLeft: number;
  /** The open time has come (server clock). */
  openable: boolean;
  openedAt: string | null;
  createdAt: string;
  /** Mine: always. To me: only once openable. */
  title?: string;
}

export interface LetterView extends LetterSummary {
  /** The author always; the recipient only after opening it (POST /letters/:id/open). */
  content: { title: string; body: string; photos: StoryPhotoView[] } | null;
  editedAt: string | null;
}

export interface LetterList {
  /** "Thư cho bạn": openable, then sealed, then opened. */
  inbox: LetterSummary[];
  /** "Thư bạn đã gửi", newest first. */
  sent: LetterSummary[];
}

export interface LetterInput {
  title: string;
  body: string;
  openOn: string;
  photos: { key: string; width: number; height: number }[];
}

/** Home card "💌 Có thư từ Hà mở được hôm nay". */
export interface PulseLetters {
  /** Unopened letters to me whose time has come. */
  openable: number;
  /** The oldest of them. */
  openableId: string | null;
  /** Open date of my next sealed letter. */
  nextOpenOn: string | null;
}

// ── Hidden friends space ("Hội bạn bè", plan/PROJECT_SUMMARY.md) ──

export interface FriendUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** incoming = they sent me a request; outgoing = I sent one; self = my own profile. */
export type FriendRelation = 'none' | 'friend' | 'incoming' | 'outgoing' | 'self';

export interface FriendRequest {
  id: string;
  user: FriendUser;
  createdAt: string;
}

export interface FriendsOverview {
  friends: { user: FriendUser; since: string }[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface FriendPerson {
  user: FriendUser;
  relation: FriendRelation;
  /** Pending request between us, else null. */
  requestId: string | null;
}

export interface FriendStory {
  id: string;
  author: FriendUser;
  isMine: boolean;
  body: string;
  photos: StoryPhotoView[];
  /** total = everyone's reactions; top = up to 3 most used types. */
  reactions: { mine: ReactionType | null; total: number; top: ReactionType[] };
  commentCount: number;
  /** BB6; null when the post has no poll. */
  poll: FriendPoll | null;
  createdAt: string;
  editedAt: string | null;
}

export interface FriendPollOption {
  id: string;
  text: string;
  /** Everyone who chose it. */
  count: number;
  /** Up to 3 voters, newest first (never people blocked either way). */
  voterPreview: FriendUser[];
}

/** Poll in a friends post (BB6). Results are always shown; % = count / totalVoters. */
export interface FriendPoll {
  options: FriendPollOption[];
  totalVoters: number;
  /** My option ids (empty: not voted). */
  mine: string[];
  multi: boolean;
  endsAt: string | null;
  closed: boolean;
}

export type PollDurationDays = 0 | 1 | 3 | 7;

/** Edit: poll left out = keep it; durationDays left out = keep the deadline. */
export interface FriendPollInput {
  options: string[];
  multi: boolean;
  durationDays?: PollDurationDays;
}

export interface PollVoters {
  option: string;
  count: number;
  items: FriendUser[];
}

export interface FriendStoryPage {
  items: FriendStory[];
  nextCursor: string | null;
}

/** "@Tên" inside a comment body: body.slice(offset, offset + length) (JavaScript string indexes). */
export interface MentionSpan {
  userId: string;
  offset: number;
  length: number;
}

export interface FriendComment {
  id: string;
  author: FriendUser;
  isMine: boolean;
  /** My comment, or any comment on my post. */
  canDelete: boolean;
  body: string;
  createdAt: string;
  /** Root comment this reply belongs to (one level); null for a root comment. */
  parentId: string | null;
  /** People named in the body (people blocked either way are left out: shown as plain text). */
  mentions: MentionSpan[];
}

/** GET comments: root comments with their replies (BB8). */
export interface FriendCommentThread extends FriendComment {
  replies: FriendComment[];
}

export interface FriendCommentInput {
  body: string;
  parentId?: string;
  mentions?: MentionSpan[];
}

/** "Những người bạn có thể biết" (BB7). */
export interface FriendSuggestion {
  user: FriendUser;
  mutualCount: number;
  /** Up to 3 of the mutual friends. */
  mutualPreview: FriendUser[];
}

export interface FriendStoryInput {
  body: string;
  photos: { key: string; width: number; height: number }[];
  /** Create: a poll or nothing. Edit: left out = keep; null = remove (only without votes). */
  poll?: FriendPollInput | null;
}

// ── "Lên kèo" (BB5) ──

export type RsvpStatus = 'going' | 'maybe' | 'declined';

export interface FriendEvent {
  id: string;
  creator: FriendUser;
  isMine: boolean;
  title: string;
  /** UTC instants; shown in the phone's timezone. */
  startAt: string;
  endAt: string | null;
  /** From then on "Đã qua": endAt, or 6 hours after the start. */
  pastAt: string;
  past: boolean;
  place: string;
  mapUrl: string | null;
  description: string;
  cover: { key: string; url: string; width: number; height: number } | null;
  status: 'active' | 'cancelled';
  /** Always "going" for the creator; null = not answered. */
  myRsvp: RsvpStatus | null;
  /** The creator counts as going. */
  counts: { going: number; maybe: number; declined: number; pending: number };
  /** Up to 5 people going, the creator first. */
  goingPreview: FriendUser[];
  commentCount: number;
  editedAt: string | null;
  createdAt: string;
}

export interface FriendEventGuest extends FriendUser {
  isCreator: boolean;
}

export interface FriendEventDetail extends FriendEvent {
  guests: { going: FriendEventGuest[]; maybe: FriendEventGuest[]; pending: FriendEventGuest[]; declined: FriendEventGuest[] };
  /** Creator only: everyone invited. */
  invitedIds?: string[];
}

export interface FriendEventInput {
  title: string;
  startAt: string;
  endAt: string | null;
  place: string;
  mapUrl: string | null;
  description: string;
  cover: { key: string; width: number; height: number } | null;
}

// ── Friends space, wave 1 (plan/ENGINEERING_WORKFLOW.md BB1–BB4) ──

export type FriendNotificationType =
  | 'friend_request'
  | 'friend_accepted'
  | 'story_reaction'
  | 'story_comment'
  | 'invite_joined'
  | 'comment_reply'
  | 'mention'
  | 'poll_closed'
  | 'event_invite'
  | 'event_rsvp'
  | 'event_changed'
  | 'event_cancelled'
  | 'event_comment'
  | 'event_reminder'
  | 'outing_invite'
  | 'outing_changed'
  | 'outing_review'
  | 'outing_closed'
  | 'outing_settlement'
  | 'outing_completed';

export interface FriendNotification {
  id: string;
  type: FriendNotificationType;
  /** Up to 3, newest first. */
  actors: FriendUser[];
  /** Everyone involved (for "và N người khác"). */
  actorCount: number;
  /** comment: id = the comment to open (root comment for a reply), storyId = its post, excerpt = that comment. */
  entity:
    | { kind: 'story'; id: string; excerpt: string }
    | { kind: 'request'; id: string }
    | { kind: 'comment'; id: string; storyId: string; excerpt: string }
    /** BB5: excerpt = the event title. */
    | { kind: 'event'; id: string; excerpt: string }
    /** Restricted history never includes actor profiles or private outing content. */
    | { kind: 'outing'; id: string; restricted: boolean }
    | null;
  read: boolean;
  updatedAt: string;
}

export interface FriendNotificationPage {
  items: FriendNotification[];
  nextCursor: string | null;
}

export interface FriendsUnread {
  /** Visible activity since last seen, capped at 99; not a count of unread-highlighted rows. */
  notifications: number;
  /** Cap reached or candidate scan budget exhausted: the count may be a lower bound. */
  notificationsSaturated: boolean;
  friendRequests: number;
  messages: number;
}

export interface FriendProfile {
  user: FriendUser & { bio: string };
  relation: FriendRelation;
  requestId: string | null;
  friendCount: number;
  mutual: { count: number; preview: FriendUser[] };
  /** Self or friend: may see posts and the friend list. */
  canSeePosts: boolean;
}

export interface FriendListPage {
  items: FriendUser[];
  total: number;
  nextOffset: number | null;
}

export interface BlockedFriend {
  user: FriendUser;
  blockedAt: string;
}

export type ReportTarget = 'user' | 'story' | 'comment' | 'event' | 'event_comment';
export type ReportReason = 'spam' | 'harassment' | 'sensitive' | 'violence' | 'fake' | 'other';

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface FriendInvite {
  id: string;
  code: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  status: InviteStatus;
}

export interface InvitePreview {
  valid: boolean;
  inviter?: { displayName: string; avatarUrl: string | null };
}

/** friended = now friends with the inviter; invalid = expired, used up or revoked (the server never says which). */
export interface JoinResult {
  joinedAt: string;
  invite?: { status: 'friended' | 'already_friends' | 'self' | 'invalid'; inviter?: FriendUser };
}

// ── Cash flow (linked bank account, plan/PROJECT_SUMMARY.md) ──

export type FinanceVisibility = 'private' | 'partner';
export type BankConnectionStatus = 'active' | 'error' | 'revoked';
export type TxnDirection = 'in' | 'out';

/** My link state. Never contains the token. */
export interface FinanceConnection {
  linked: boolean;
  /** null = never linked; 'revoked' = disconnected (history may be kept). */
  status: BankConnectionStatus | null;
  bankBrand: string | null;
  accountLast4: string | null;
  lastSuccessAt: string | null;
  /** "CODE: message" when the last poll failed. */
  lastError: string | null;
  visibility: FinanceVisibility;
}

export interface BankTxn {
  id: string;
  direction: TxnDirection;
  /** VND, positive integer. */
  amount: number;
  occurredAt: string;
  /** YYYY-MM-DD in the owner's timezone. */
  localDate: string;
  note: string;
  isMine: boolean;
}

export interface BankTxnPage {
  items: BankTxn[];
  nextCursor: string | null;
}

export interface FinanceSummary {
  month: string;
  totalIn: number;
  totalOut: number;
  net: number;
  count: number;
}

export interface FinanceLinkResult {
  connection: FinanceConnection;
  imported: number;
}

export interface FinanceSyncResult {
  connection: FinanceConnection;
  /** false when the last poll was < 60 s ago (reused) or the provider failed (see error). */
  synced: boolean;
  inserted: number;
  error: { code: string; message: string } | null;
}

export interface FinanceDisconnectResult {
  connection: FinanceConnection;
  deleted: number;
}

// ── AI spending assistant (plan/PROJECT_SUMMARY.md): own data only, last month + this month ──

export type SpendCategory = 'food' | 'transport' | 'shopping' | 'bills' | 'fun' | 'health' | 'gift' | 'travel' | 'home' | 'other';

export interface AssistantCoverage {
  /** Analysis window (local dates): 1st of last month → today. */
  from: string;
  to: string;
  /** Oldest / newest stored transaction in the window; null when there is none. */
  firstDate: string | null;
  lastDate: string | null;
  spanDays: number;
  txnCount: number;
  notedCount: number;
  outCount: number;
  outUnnotedCount: number;
}

export interface AssistantCategoryTotal {
  key: SpendCategory | 'unnoted';
  /** VND, computed by the server (never by the AI). */
  amount: number;
  count: number;
  /** 0..1 of total spend. */
  share: number;
}

export interface AssistantSuggestion {
  title: string;
  detail: string;
  /** AI estimate per month, VND. */
  estimatedSavingVnd: number | null;
}

export interface AssistantInsights {
  headline: string;
  observations: string[];
  suggestions: AssistantSuggestion[];
  noteTip: string | null;
  categories: AssistantCategoryTotal[];
  generatedAt: string;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AssistantState {
  consented: boolean;
  consentedAt: string | null;
  coverage: AssistantCoverage;
  insights: AssistantInsights | null;
  /** Transactions or notes changed after the insights were generated. */
  stale: boolean;
  messages: AssistantMessage[];
}

export interface AssistantInsightsResult {
  insights: AssistantInsights;
  stale: boolean;
  coverage: AssistantCoverage;
}

export interface AssistantChatResult {
  question: AssistantMessage;
  reply: AssistantMessage;
}

// ── Web Push (N4) ────────────────────────────────────────

export type PushSpace = 'couple' | 'friends';

export interface PushConfig {
  /** false: the server has no VAPID keys, push is off. */
  enabled: boolean;
  publicKey: string | null;
}

export interface PushQuiet {
  enabled: boolean;
  /** "HH:mm", the user's timezone. */
  from: string;
  to: string;
}

/** GET /api/push/settings?space= — only the groups of that space. */
export interface PushSettings {
  space: PushSpace;
  groups: Record<string, boolean>;
  /** "Hiện nội dung": false = the lock screen shows only "Bạn có thông báo mới". */
  preview: boolean;
  quiet: PushQuiet;
}

export interface PushSettingsPatch {
  space: PushSpace;
  groups?: Record<string, boolean>;
  preview?: boolean;
  quiet?: Partial<PushQuiet>;
}

// ── Bucket list (CP3) ───────────────────────────────────

export type BucketCategory = 'travel' | 'food' | 'experience' | 'learning' | 'other';
export type BucketStatus = 'todo' | 'done';

export interface BucketItem {
  id: string;
  title: string;
  emoji: string;
  category: BucketCategory;
  note: string;
  dueOn: string | null;
  pinned: boolean;
  ideaId: string | null;
  status: BucketStatus;
  doneOn: string | null;
  doneBy: string | null;
  doneAt: string | null;
  doneNote: string;
  /** The memory posted when it was done; null when none or deleted since. */
  storyId: string | null;
  rewarded: boolean;
  /** "Đánh dấu chưa làm" possible until then; null otherwise. */
  reopenUntil: string | null;
  /** Earliest day accepted as doneOn. */
  doneOnMin: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BucketList {
  status: BucketStatus;
  items: BucketItem[];
  counts: { todo: number; done: number };
}

export interface BucketIdea {
  id: string;
  title: string;
  emoji: string;
  category: BucketCategory;
  added: boolean;
}

export interface BucketIdeas {
  categories: { key: BucketCategory; label: string; emoji: string }[];
  ideas: BucketIdea[];
}

export interface BucketInput {
  title?: string;
  emoji?: string;
  category?: BucketCategory;
  note?: string;
  dueOn?: string | null;
  pinned?: boolean;
  ideaId?: string;
}

export interface BucketCompleteInput {
  doneOn: string;
  note: string;
  photos: { key: string; width: number; height: number }[];
  postStory: boolean;
}

export interface BucketCompleteResult {
  item: BucketItem;
  story: Story | null;
  reward: { coin: number; exp: number; leveledUp: boolean } | null;
  rewardSkipped: { reason: 'too_new' | 'daily_limit' | 'already_rewarded' | 'failed'; message: string } | null;
}
