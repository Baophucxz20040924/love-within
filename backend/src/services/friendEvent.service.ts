import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import {
  EVENT_DEFAULT_LENGTH_MS,
  EVENT_MAX_AHEAD_MS,
  EVENT_MAX_LENGTH_MS,
  MAX_EVENT_INVITEES,
  type EventCover,
  type FriendEventCommentDoc,
  type FriendEventDoc,
  type FriendEventStatus,
  type RsvpStatus,
} from '../models/FriendEvent.js';
import type { UserDoc } from '../models/User.js';
import { getStorage } from '../integrations/index.js';
import { friendEventCommentRepository, friendEventRepository, type FriendEventInput } from '../repositories/friendEvent.repository.js';
import { friendshipRepository, pairKeyOf } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { FriendCommentThreadView, FriendCommentView } from './friendStory.service.js';
import { notificationService } from './notification.service.js';
import { profileOf, profileService, type PublicProfile } from './profile.service.js';
import { STORY_IMAGE_TYPES } from './story.service.js';

// "Lên kèo" (plan/ENGINEERING_WORKFLOW.md, BB5). Who sees an event: its creator, and the people invited while they are still
// friends of the creator (checked on every read, so unfriending or blocking the creator removes access at once: 404, the
// same answer as an event that does not exist). Only the creator invites (v1), and only their current friends, at most
// 100. Guests see each other (name + photo) even when they are not friends, except people blocked either way. Times are
// UTC; the app shows them in the phone's timezone. Titles, places, descriptions and comments are never logged.

export interface FriendEventCreateInput {
  title: string;
  startAt: string;
  endAt?: string | null;
  place?: string;
  mapUrl?: string | null;
  description?: string;
  cover?: EventCover | null;
  inviteeIds?: string[];
}

/** PATCH: only what is sent changes (null clears endAt, mapUrl, cover). Invitees change through invite(). */
export type FriendEventUpdateInput = Partial<Omit<FriendEventCreateInput, 'inviteeIds'>>;

export interface EventCounts {
  /** The creator counts as going. */
  going: number;
  maybe: number;
  declined: number;
  /** Invited, no answer yet. */
  pending: number;
}

export interface FriendEventView {
  id: string;
  creator: PublicProfile;
  isMine: boolean;
  title: string;
  startAt: string;
  endAt: string | null;
  /** From then on "Đã qua": endAt, or 6 hours after the start. */
  pastAt: string;
  past: boolean;
  place: string;
  mapUrl: string | null;
  description: string;
  cover: { key: string; url: string; width: number; height: number } | null;
  status: FriendEventStatus;
  /** My answer; always "going" for the creator; null = not answered. */
  myRsvp: RsvpStatus | null;
  counts: EventCounts;
  /** Up to 5 people going, the creator first (cards). */
  goingPreview: PublicProfile[];
  commentCount: number;
  editedAt: string | null;
  createdAt: string;
}

export interface GuestView extends PublicProfile {
  isCreator: boolean;
}

/** Detail page: the guest list by answer (people blocked either way with me left out). */
export interface FriendEventDetailView extends FriendEventView {
  guests: { going: GuestView[]; maybe: GuestView[]; pending: GuestView[]; declined: GuestView[] };
  /** Creator only: ids of everyone invited (also people no longer friends), for "Mời thêm". */
  invitedIds?: string[];
}

const EVENT_NOT_FOUND = 'Kèo không tồn tại hoặc bạn không còn xem được';
const COMMENT_NOT_FOUND = 'Bình luận không tồn tại';
const LIST_LIMIT = 50;
const GOING_PREVIEW = 5;

const eventErrors = {
  notFound: () => Errors.notFound(EVENT_NOT_FOUND),
  notCreator: () => Errors.forbidden('Chỉ người tạo kèo mới làm được việc này'),
  cancelled: () => new AppError(409, 'EVENT_CANCELLED', 'Kèo này đã bị hủy'),
  past: () => new AppError(409, 'EVENT_PAST', 'Kèo này đã qua'),
  inPast: () => new AppError(400, 'EVENT_IN_PAST', 'Giờ bắt đầu phải ở tương lai'),
  tooFar: () => new AppError(400, 'EVENT_TOO_FAR', 'Chỉ lên kèo trong vòng 2 năm tới'),
  endBeforeStart: () => new AppError(400, 'EVENT_END_BEFORE_START', 'Giờ kết thúc phải sau giờ bắt đầu'),
  tooLong: () => new AppError(400, 'EVENT_TOO_LONG', 'Một kèo kéo dài tối đa 30 ngày'),
  badMapUrl: () => new AppError(400, 'BAD_MAP_URL', 'Link bản đồ phải là một địa chỉ https://'),
  notFriend: () => new AppError(400, 'INVITE_NOT_FRIEND', 'Chỉ mời được bạn bè của bạn'),
  tooMany: () => new AppError(400, 'TOO_MANY_INVITEES', `Mỗi kèo mời tối đa ${MAX_EVENT_INVITEES} người`),
  creatorRsvp: () => new AppError(400, 'CREATOR_RSVP', 'Bạn là người tạo kèo nên luôn có tên trong danh sách đi'),
  notCancelled: () => new AppError(409, 'EVENT_NOT_CANCELLED', 'Hãy hủy kèo trước khi xóa để mọi người được báo'),
};

const toObjectIds = (ids: Iterable<string>) => [...ids].map((id) => new Types.ObjectId(id));

function coverPrefix(userId: Types.ObjectId): string {
  return `friends/${userId.toString()}/events/`;
}

function pastAtOf(startAt: Date, endAt: Date | null): Date {
  return endAt ?? new Date(startAt.getTime() + EVENT_DEFAULT_LENGTH_MS);
}

const isPast = (ev: Pick<FriendEventDoc, 'pastAt'>, now: Date) => ev.pastAt.getTime() <= now.getTime();

/** Start in the future (when it is new or moved), at most 2 years ahead; end after start, at most 30 days later. */
function checkTimes(startAt: Date, endAt: Date | null, now: Date, startMoved: boolean): void {
  if (startMoved && startAt.getTime() <= now.getTime()) throw eventErrors.inPast();
  if (startAt.getTime() > now.getTime() + EVENT_MAX_AHEAD_MS) throw eventErrors.tooFar();
  if (endAt) {
    if (endAt.getTime() <= startAt.getTime()) throw eventErrors.endBeforeStart();
    if (endAt.getTime() - startAt.getTime() > EVENT_MAX_LENGTH_MS) throw eventErrors.tooLong();
  }
}

/** https only, no user:password@ (the app opens it in a new tab). */
export function isSafeMapUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function normalizeMapUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim() ?? '';
  if (!s) return null;
  if (!isSafeMapUrl(s)) throw eventErrors.badMapUrl();
  return s;
}

/** The cover must live under the creator's own events prefix and really exist in storage. */
async function validateCover(me: UserDoc, cover: EventCover): Promise<EventCover> {
  if (!cover.key.startsWith(coverPrefix(me._id)) || cover.key.includes('..')) {
    logger.warn('Rejected foreign friend-event cover key', { userId: me._id.toString(), key: cover.key });
    throw Errors.forbidden('Ảnh không thuộc tài khoản của bạn');
  }
  const head = await getStorage().headObject(cover.key);
  if (!head) throw Errors.badRequest('Ảnh bìa chưa tải lên xong. Thử lại nhé.');
  if (head.size > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');
  return { key: cover.key, width: cover.width, height: cover.height };
}

/** New invitees: unique, never the creator, current unblocked friends, at most 100 in total. */
async function checkInvitees(me: UserDoc, raw: string[], already: Types.ObjectId[]): Promise<Types.ObjectId[]> {
  const known = new Set(already.map((id) => id.toString()));
  const wanted = [...new Set(raw)].filter((id) => !known.has(id));
  if (wanted.some((id) => me._id.equals(id))) throw Errors.badRequest('Bạn không cần tự mời mình');
  if (wanted.length === 0) return [];
  if (known.size + wanted.length > MAX_EVENT_INVITEES) throw eventErrors.tooMany();
  const accepted = await friendshipRepository.acceptedUnblockedPairKeys(wanted.map((id) => [me._id, id] as const));
  if (wanted.some((id) => !accepted.has(pairKeyOf(me._id, id)))) throw eventErrors.notFriend();
  return toObjectIds(wanted);
}

/** Invitees who can still see the event (current friends of the creator). */
function seeingInvitees(ev: FriendEventDoc, creatorFriends: ReadonlySet<string>): Types.ObjectId[] {
  return ev.inviteeIds.filter((id) => creatorFriends.has(id.toString()));
}

/** Only relationships appearing in these events, never entire creators' friend networks. */
async function creatorFriendSets(events: FriendEventDoc[]): Promise<Map<string, Set<string>>> {
  const accepted = await friendshipRepository.acceptedUnblockedPairKeys(
    events.flatMap((ev) => ev.inviteeIds.map((id) => [ev.creatorId, id] as const)),
  );
  const byCreator = new Map<string, Set<string>>();
  for (const ev of events) {
    const key = ev.creatorId.toString();
    let friends = byCreator.get(key);
    if (!friends) {
      friends = new Set();
      byCreator.set(key, friends);
    }
    for (const id of ev.inviteeIds) {
      if (accepted.has(pairKeyOf(ev.creatorId, id))) friends.add(id.toString());
    }
  }
  return byCreator;
}

async function eventFriends(ev: FriendEventDoc): Promise<Set<string>> {
  return (await creatorFriendSets([ev])).get(ev.creatorId.toString()) ?? new Set();
}

/** Creator, or an invitee who is still a friend of the creator (event not hidden after reports). */
async function canSee(userId: Types.ObjectId, ev: FriendEventDoc): Promise<boolean> {
  if (ev.creatorId.equals(userId)) return true;
  if (ev.hiddenByReportsAt || !ev.inviteeIds.some((id) => id.equals(userId))) return false;
  if (await friendBlockRepository.isBlockedBetween(userId, ev.creatorId)) return false;
  return friendshipRepository.areFriends(userId, ev.creatorId);
}

async function requireVisible(me: UserDoc, id: string | Types.ObjectId): Promise<FriendEventDoc> {
  const ev = await friendEventRepository.findById(id);
  if (!ev || !(await canSee(me._id, ev))) throw eventErrors.notFound();
  return ev;
}

async function requireOwn(me: UserDoc, id: string): Promise<FriendEventDoc> {
  const ev = await requireVisible(me, id);
  if (!ev.creatorId.equals(me._id)) throw eventErrors.notCreator();
  return ev;
}

/** Open for changes and answers: active and not over. */
function requireOpen(ev: FriendEventDoc, now: Date): void {
  if (ev.status === 'cancelled') throw eventErrors.cancelled();
  if (isPast(ev, now)) throw eventErrors.past();
}

/** After a conditional update matched nothing: say why, for the state the event is in now. */
async function explainMiss(me: UserDoc, id: string): Promise<never> {
  const again = await requireVisible(me, id);
  requireOpen(again, new Date());
  throw Errors.conflict('Kèo vừa thay đổi, tải lại trang nhé');
}

interface Guests {
  going: Types.ObjectId[];
  maybe: Types.ObjectId[];
  pending: Types.ObjectId[];
  declined: Types.ObjectId[];
}

/** The creator first in "going", then invitees still friends of the creator, without people blocked either way with me. */
function guestsOf(ev: FriendEventDoc, creatorFriends: ReadonlySet<string>, blocked: ReadonlySet<string>): Guests {
  const out: Guests = { going: [ev.creatorId], maybe: [], pending: [], declined: [] };
  for (const id of seeingInvitees(ev, creatorFriends)) {
    if (blocked.has(id.toString())) continue;
    const answer = ev.rsvps?.get(id.toString());
    if (answer === 'going') out.going.push(id);
    else if (answer === 'maybe') out.maybe.push(id);
    else if (answer === 'declined') out.declined.push(id);
    else out.pending.push(id);
  }
  return out;
}

async function coverView(cover: EventCover | null): Promise<FriendEventView['cover']> {
  if (!cover) return null;
  const { url } = await getStorage().getDownloadUrl(cover.key, { cacheable: true });
  return { key: cover.key, url, width: cover.width, height: cover.height };
}

async function baseView(ev: FriendEventDoc, me: UserDoc, guests: Guests, profiles: Map<string, PublicProfile>, now: Date): Promise<FriendEventView> {
  const isMine = ev.creatorId.equals(me._id);
  return {
    id: ev._id.toString(),
    creator: profileOf(profiles, ev.creatorId),
    isMine,
    title: ev.title,
    startAt: ev.startAt.toISOString(),
    endAt: ev.endAt ? ev.endAt.toISOString() : null,
    pastAt: ev.pastAt.toISOString(),
    past: isPast(ev, now),
    place: ev.place ?? '',
    mapUrl: ev.mapUrl ?? null,
    description: ev.description ?? '',
    cover: await coverView(ev.cover),
    status: ev.status,
    myRsvp: isMine ? 'going' : (ev.rsvps?.get(me._id.toString()) ?? null),
    counts: { going: guests.going.length, maybe: guests.maybe.length, declined: guests.declined.length, pending: guests.pending.length },
    goingPreview: guests.going.slice(0, GOING_PREVIEW).map((id) => profileOf(profiles, id)),
    commentCount: ev.commentCount ?? 0,
    editedAt: ev.editedAt ? ev.editedAt.toISOString() : null,
    createdAt: ev.createdAt.toISOString(),
  };
}

/** Cards: one friend list per distinct creator, one block list, one profile query. */
async function listViews(me: UserDoc, events: FriendEventDoc[]): Promise<FriendEventView[]> {
  if (events.length === 0) return [];
  const now = new Date();
  const [blocked, friendsOf] = await Promise.all([
    friendBlockRepository.blockedIdsFor(me._id),
    creatorFriendSets(events),
  ]);
  const guests = events.map((e) => guestsOf(e, friendsOf.get(e.creatorId.toString()) ?? new Set(), blocked));
  const profiles = await profileService.load(guests.flatMap((g) => g.going.slice(0, GOING_PREVIEW)));
  return Promise.all(events.map((e, i) => baseView(e, me, guests[i], profiles, now)));
}

async function detailView(me: UserDoc, ev: FriendEventDoc): Promise<FriendEventDetailView> {
  const [blocked, creatorFriends] = await Promise.all([friendBlockRepository.blockedIdsFor(me._id), eventFriends(ev)]);
  const guests = guestsOf(ev, creatorFriends, blocked);
  const profiles = await profileService.load([...guests.going, ...guests.maybe, ...guests.pending, ...guests.declined]);
  const base = await baseView(ev, me, guests, profiles, new Date());
  const guest = (id: Types.ObjectId): GuestView => ({ ...profileOf(profiles, id), isCreator: id.equals(ev.creatorId) });
  const view: FriendEventDetailView = {
    ...base,
    guests: { going: guests.going.map(guest), maybe: guests.maybe.map(guest), pending: guests.pending.map(guest), declined: guests.declined.map(guest) },
  };
  if (base.isMine) view.invitedIds = ev.inviteeIds.map((id) => id.toString());
  return view;
}

/** Tell these people (each once; emit skips the actor and people blocked either way). */
async function notifyMany(to: Types.ObjectId[], type: 'event_invite' | 'event_changed' | 'event_cancelled' | 'event_comment', actorId: Types.ObjectId, eventId: Types.ObjectId) {
  const seen = new Set<string>();
  for (const id of to) {
    const key = id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    await notificationService.emit({ space: 'friends', to: id, type, actorId, entityId: eventId });
  }
}

/** Going and maybe, among the invitees who can still see the event. */
function goingOrMaybe(ev: FriendEventDoc, creatorFriends: ReadonlySet<string>): Types.ObjectId[] {
  return seeingInvitees(ev, creatorFriends).filter((id) => {
    const a = ev.rsvps?.get(id.toString());
    return a === 'going' || a === 'maybe';
  });
}

function toCommentView(c: FriendEventCommentDoc, userId: string, creatorId: string, profiles: Map<string, PublicProfile>): FriendCommentView {
  const authorId = c.authorId.toString();
  return {
    id: c._id.toString(),
    author: profileOf(profiles, c.authorId),
    isMine: authorId === userId,
    canDelete: authorId === userId || creatorId === userId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    parentId: c.parentId ? c.parentId.toString() : null,
    // No "@" names in event discussions (v1): same shape as post comments.
    mentions: [],
  };
}

function commentVisibleTo(me: UserDoc, c: Pick<FriendEventCommentDoc, 'authorId' | 'hiddenByReportsAt'>, blocked: ReadonlySet<string>): boolean {
  return c.authorId.equals(me._id) || (!c.hiddenByReportsAt && !blocked.has(c.authorId.toString()));
}

const timeOf = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

export const friendEventService = {
  /** Upcoming (soonest first) or past (most recent first) events I created or am invited to, at most 50. */
  async list(me: UserDoc, scope: 'upcoming' | 'past', limit = LIST_LIMIT): Promise<{ items: FriendEventView[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw Errors.badRequest('Giới hạn danh sách không hợp lệ');
    const [friendIds, blocked] = await Promise.all([
      friendshipRepository.friendIds(me._id), friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const events = await friendEventRepository.listFor(me._id, friendIds.filter((id) => !blocked.has(id.toString())), scope, new Date(), limit);
    return { items: await listViews(me, events) };
  },

  async get(me: UserDoc, id: string): Promise<FriendEventDetailView> {
    return detailView(me, await requireVisible(me, id));
  },

  /** For reports: the event if the caller may see it (404 otherwise). */
  visibleEvent: requireVisible,

  /** For reports: an event comment and its event if the caller may see both (a reply also needs its root). */
  async visibleComment(me: UserDoc, commentId: string): Promise<{ comment: FriendEventCommentDoc; event: FriendEventDoc }> {
    const comment = await friendEventCommentRepository.findAnyById(commentId);
    if (!comment) throw Errors.notFound(COMMENT_NOT_FOUND);
    const event = await requireVisible(me, comment.eventId);
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    if (!commentVisibleTo(me, comment, blocked)) throw Errors.notFound(COMMENT_NOT_FOUND);
    if (comment.parentId) {
      const root = await friendEventCommentRepository.findById(event._id, comment.parentId);
      if (!root || !commentVisibleTo(me, root, blocked)) throw Errors.notFound(COMMENT_NOT_FOUND);
    }
    return { comment, event };
  },

  /** Presigned PUT for a cover photo: friends/<me>/events/<YYYY-MM>/<uuid>.<ext>. */
  async createUploadUrl(me: UserDoc, mimeType: string, sizeBytes: number) {
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const month = getLocalDate(new Date(), me.timezone).slice(0, 7);
    const imageKey = `${coverPrefix(me._id)}${month}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  /** New event; every invitee gets event_invite. */
  async create(me: UserDoc, input: FriendEventCreateInput): Promise<FriendEventDetailView> {
    const now = new Date();
    const startAt = new Date(input.startAt);
    const endAt = timeOf(input.endAt);
    checkTimes(startAt, endAt, now, true);
    const mapUrl = normalizeMapUrl(input.mapUrl);
    const inviteeIds = await checkInvitees(me, input.inviteeIds ?? [], []);
    const cover = input.cover ? await validateCover(me, input.cover) : null;
    const ev = await friendEventRepository.create({
      creatorId: me._id,
      title: input.title.trim(),
      startAt,
      endAt,
      pastAt: pastAtOf(startAt, endAt),
      place: (input.place ?? '').trim(),
      mapUrl,
      description: (input.description ?? '').trim(),
      cover,
      inviteeIds,
    });
    logger.info('Friend event created', { userId: me._id.toString(), eventId: ev._id.toString(), invitees: inviteeIds.length, cover: Boolean(cover) });
    await notifyMany(inviteeIds, 'event_invite', me._id, ev._id);
    return detailView(me, ev);
  },

  /**
   * Creator only, while the event is active and not over. A new start time must be in the future. Changing the time
   * (start or end) or the place (text or map link) tells the people who answered Đi or Có thể (event_changed); a new
   * start time also re-arms the 2-hour reminder (its key holds the start time).
   */
  async update(me: UserDoc, id: string, input: FriendEventUpdateInput): Promise<FriendEventDetailView> {
    const ev = await requireOwn(me, id);
    const now = new Date();
    requireOpen(ev, now);

    const startAt = input.startAt !== undefined ? new Date(input.startAt) : ev.startAt;
    const endAt = input.endAt !== undefined ? timeOf(input.endAt) : ev.endAt;
    const startMoved = startAt.getTime() !== ev.startAt.getTime();
    const endMoved = (endAt?.getTime() ?? null) !== (ev.endAt?.getTime() ?? null);
    if (startMoved || endMoved) checkTimes(startAt, endAt, now, startMoved);
    const place = input.place !== undefined ? input.place.trim() : ev.place;
    const mapUrl = input.mapUrl !== undefined ? normalizeMapUrl(input.mapUrl) : ev.mapUrl;
    const placeMoved = place !== ev.place || mapUrl !== ev.mapUrl;

    const set: Partial<FriendEventInput> = {};
    if (input.title !== undefined && input.title.trim() !== ev.title) set.title = input.title.trim();
    if (input.description !== undefined && input.description.trim() !== ev.description) set.description = input.description.trim();
    if (startMoved || endMoved) Object.assign(set, { startAt, endAt, pastAt: pastAtOf(startAt, endAt) });
    if (placeMoved) Object.assign(set, { place, mapUrl });
    let droppedCover: string | null = null;
    if (input.cover !== undefined && (input.cover?.key ?? null) !== (ev.cover?.key ?? null)) {
      set.cover = input.cover ? await validateCover(me, input.cover) : null;
      droppedCover = ev.cover?.key ?? null;
    }
    if (Object.keys(set).length === 0) return detailView(me, ev);

    const updated = await friendEventRepository.update(id, me._id, set, now);
    if (!updated) return explainMiss(me, id);
    if (droppedCover) {
      await getStorage()
        .deleteObject(droppedCover)
        .catch((err: Error) => logger.warn('Could not delete replaced friend-event cover', { key: droppedCover, message: err.message }));
    }
    const timeChanged = startMoved || endMoved;
    if (timeChanged || placeMoved) {
      await notifyMany(goingOrMaybe(updated, await eventFriends(updated)), 'event_changed', me._id, updated._id);
    }
    logger.info('Friend event edited', { userId: me._id.toString(), eventId: id, timeChanged, placeChanged: placeMoved, fields: Object.keys(set) });
    return detailView(me, updated);
  },

  /** Creator invites more of their friends (v1: nobody else invites). People already invited are skipped. */
  async invite(me: UserDoc, id: string, userIds: string[]): Promise<FriendEventDetailView> {
    const ev = await requireOwn(me, id);
    const now = new Date();
    requireOpen(ev, now);
    const added = await checkInvitees(me, userIds, ev.inviteeIds);
    if (added.length === 0) return detailView(me, ev);
    const updated = await friendEventRepository.addInvitees(id, me._id, added, now);
    if (!updated) {
      // Another invite at the same moment filled the event, or it changed state.
      const again = await requireVisible(me, id);
      requireOpen(again, new Date());
      throw eventErrors.tooMany();
    }
    const fresh = added.filter((a) => !ev.inviteeIds.some((b) => b.equals(a)));
    logger.info('Friend event invitees added', { userId: me._id.toString(), eventId: id, added: fresh.length, total: updated.inviteeIds.length });
    await notifyMany(fresh, 'event_invite', me._id, updated._id);
    return detailView(me, updated);
  },

  /**
   * Đi · Có thể · Không đi (invitees only; the creator is always going). A new "Đi" tells the creator (event_rsvp, one row
   * per event); taking "Đi" back takes the person off that row.
   */
  async rsvp(me: UserDoc, id: string, status: RsvpStatus): Promise<FriendEventDetailView> {
    const ev = await requireVisible(me, id);
    if (ev.creatorId.equals(me._id)) throw eventErrors.creatorRsvp();
    requireOpen(ev, new Date());
    const before = ev.rsvps?.get(me._id.toString()) ?? null;
    const updated = await friendEventRepository.setRsvp(id, me._id, status, new Date());
    if (!updated) return explainMiss(me, id);
    if (status === 'going' && before !== 'going') {
      await notificationService.emit({ space: 'friends', to: ev.creatorId, type: 'event_rsvp', actorId: me._id, entityId: ev._id });
    } else if (before === 'going' && status !== 'going') {
      await notificationService.forgetActor(ev.creatorId, 'event_rsvp', ev._id, me._id);
    }
    return detailView(me, updated);
  },

  /** Creator only, before the event is over: everyone invited (who can still see it) gets event_cancelled. */
  async cancel(me: UserDoc, id: string): Promise<FriendEventDetailView> {
    const ev = await requireOwn(me, id);
    requireOpen(ev, new Date());
    const updated = await friendEventRepository.cancel(id, me._id, new Date());
    if (!updated) return explainMiss(me, id);
    const told = seeingInvitees(updated, await eventFriends(updated));
    logger.info('Friend event cancelled', { userId: me._id.toString(), eventId: id, told: told.length });
    await notifyMany(told, 'event_cancelled', me._id, updated._id);
    return detailView(me, updated);
  },

  /**
   * Creator only, soft delete (the cover stays in storage so an admin can restore it). An upcoming event must be cancelled
   * first (409 EVENT_NOT_CANCELLED), so nobody misses that it is off. Its notifications go.
   */
  async remove(me: UserDoc, id: string): Promise<void> {
    const ev = await requireOwn(me, id);
    if (ev.status === 'active' && !isPast(ev, new Date())) throw eventErrors.notCancelled();
    const deleted = await friendEventRepository.softDelete(id, me._id);
    if (!deleted) throw eventErrors.notFound();
    await notificationService.forgetEntity(deleted._id);
    logger.warn('Friend event deleted (soft)', { userId: me._id.toString(), eventId: id });
  },

  /** Discussion: roots oldest first with their replies, at most 500, without people blocked either way. */
  async listComments(me: UserDoc, id: string): Promise<FriendCommentThreadView[]> {
    const ev = await requireVisible(me, id);
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    const comments = await friendEventCommentRepository.list(ev._id, me._id, toObjectIds(blocked));
    const profiles = await profileService.load(comments.map((c) => c.authorId));
    const userId = me._id.toString();
    const creator = ev.creatorId.toString();
    const roots: FriendCommentThreadView[] = [];
    const byId = new Map<string, FriendCommentThreadView>();
    for (const c of comments) {
      const view = toCommentView(c, userId, creator, profiles);
      if (!c.parentId) {
        const thread = { ...view, replies: [] };
        roots.push(thread);
        byId.set(thread.id, thread);
      } else {
        byId.get(c.parentId.toString())?.replies.push(view);
      }
    }
    return roots;
  },

  /** A comment or a reply (one level). Tells the creator and the people going (event_comment, one row per event). */
  async addComment(me: UserDoc, id: string, input: { body: string; parentId?: string }): Promise<FriendCommentView> {
    const ev = await requireVisible(me, id);
    const text = input.body.trim();
    if (!text) throw Errors.badRequest('Bình luận không được để trống');
    const blocked = await friendBlockRepository.blockedIdsFor(me._id);
    let root: FriendEventCommentDoc | null = null;
    if (input.parentId) {
      const parent = await friendEventCommentRepository.findById(ev._id, input.parentId);
      if (!parent || !commentVisibleTo(me, parent, blocked)) throw Errors.notFound('Bình luận bạn trả lời không còn nữa');
      root = parent.parentId ? await friendEventCommentRepository.findById(ev._id, parent.parentId) : parent;
      if (!root || !commentVisibleTo(me, root, blocked)) throw Errors.notFound('Bình luận bạn trả lời không còn nữa');
    }
    const comment = await friendEventCommentRepository.create({ eventId: ev._id, authorId: me._id, parentId: root?._id ?? null, body: text });
    await friendEventRepository.incCommentCount(ev._id);
    const going = seeingInvitees(ev, await eventFriends(ev)).filter((u) => ev.rsvps?.get(u.toString()) === 'going');
    await notifyMany([ev.creatorId, ...going], 'event_comment', me._id, ev._id);
    return toCommentView(comment, me._id.toString(), ev.creatorId.toString(), await profileService.load([me._id]));
  },

  /** Comment author or the event creator; a root takes its replies along → removed. */
  async deleteComment(me: UserDoc, id: string, commentId: string): Promise<{ removed: number }> {
    const ev = await requireVisible(me, id);
    const comment = await friendEventCommentRepository.findById(ev._id, commentId);
    if (!comment) throw Errors.notFound(COMMENT_NOT_FOUND);
    if (!comment.authorId.equals(me._id) && !ev.creatorId.equals(me._id)) {
      throw Errors.forbidden('Bạn chỉ xóa được bình luận của mình hoặc trong kèo của mình');
    }
    const deleted = await friendEventCommentRepository.softDelete(ev._id, comment._id);
    if (!deleted) throw Errors.notFound(COMMENT_NOT_FOUND);
    let removed = 1;
    if (!deleted.parentId) removed += await friendEventCommentRepository.softDeleteReplies(ev._id, deleted._id);
    await friendEventRepository.decCommentCount(ev._id, removed);
    logger.info('Friend event comment deleted', { userId: me._id.toString(), eventId: id, commentId, removed });
    return { removed };
  },
};
