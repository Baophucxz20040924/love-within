import { Types } from 'mongoose';
import {
  EVENT_NOTIFICATION_TYPES,
  OUTING_NOTIFICATION_TYPES,
  SYSTEM_NOTIFICATION_TYPES,
  type FriendNotificationType,
} from '../models/FriendNotification.js';
import { FriendEvent } from '../models/FriendEvent.js';
import { FriendStory } from '../models/FriendStory.js';
import { FriendStoryComment } from '../models/FriendStoryComment.js';
import type { UserDoc } from '../models/User.js';
import { friendNotificationRepository, type NotificationCandidate, type NotificationCursor } from '../repositories/friendNotification.repository.js';
import { friendshipRepository, otherOf } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { friendOutingService } from './friendOuting.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import { profileOf, profileService, type PublicProfile } from './profile.service.js';

const PAGE = 20;
const MAX_BADGE = 99;
/** Work budget counts raw notification candidates, not visible notifications or unread-highlighted rows. */
export const NOTIFICATION_SCAN_BUDGET = 500;
const VISIBILITY_BATCH = 100;
const EXCERPT_CHARS = 60;
const STORY_TYPES: ReadonlySet<FriendNotificationType> = new Set(['story_reaction', 'story_comment', 'poll_closed']);
const COMMENT_TYPES: ReadonlySet<FriendNotificationType> = new Set(['comment_reply', 'mention']);

export type NotificationEntity =
  | { kind: 'story'; id: string; excerpt: string }
  | { kind: 'request'; id: string }
  | { kind: 'comment'; id: string; storyId: string; excerpt: string }
  | { kind: 'event'; id: string; excerpt: string }
  | { kind: 'outing'; id: string; restricted: boolean }
  | null;

export interface FriendNotificationView {
  id: string;
  type: FriendNotificationType;
  actors: PublicProfile[];
  actorCount: number;
  entity: NotificationEntity;
  read: boolean;
  updatedAt: string;
}

interface Visible {
  doc: NotificationCandidate;
  actorIds: Types.ObjectId[];
  recent: Types.ObjectId[];
  excerpt: string;
  storyId?: string;
  restricted?: boolean;
}

function uniqueIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  return [...new Map(ids.map((id) => [id.toString(), id])).values()];
}

function excerptOf(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

function encodeCursor(doc: NotificationCandidate): string {
  return `${doc.updatedAt.getTime()}_${doc._id.toString()}`;
}

function decodeCursor(cursor: string | undefined): NotificationCursor | null {
  const m = cursor?.match(/^(\d{1,15})_([a-f\d]{24})$/i);
  return m ? { at: new Date(Number(m[1])), id: new Types.ObjectId(m[2]) } : null;
}

interface CommentVisibility {
  _id: Types.ObjectId;
  storyId: Types.ObjectId;
  authorId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  hiddenByReportsAt: Date | null;
  body?: string;
}

/** Badge queries exclude bodies, including root comments; source-author blocks override stale friendship edges. */
async function openableComments(me: UserDoc, ids: Types.ObjectId[], blocked: ReadonlySet<string>, excerpts: boolean) {
  const out = new Map<string, { storyId: string; body: string }>();
  if (ids.length === 0) return out;
  const fields = '_id storyId authorId parentId hiddenByReportsAt';
  const comments = await FriendStoryComment.find({ _id: { $in: uniqueIds(ids) }, deletedAt: null })
    .select(excerpts ? `${fields} body` : fields).lean<CommentVisibility[]>().exec();
  const known = new Map(comments.map((c) => [c._id.toString(), c]));
  const missingRoots = uniqueIds(comments.filter((c) => c.parentId && !known.has(c.parentId.toString())).map((c) => c.parentId as Types.ObjectId));
  if (missingRoots.length) {
    const roots = await FriendStoryComment.find({ _id: { $in: missingRoots }, deletedAt: null })
      .select(fields).lean<CommentVisibility[]>().exec();
    for (const root of roots) known.set(root._id.toString(), root);
  }
  const seeable = (c: CommentVisibility) => c.authorId.equals(me._id) || (!c.hiddenByReportsAt && !blocked.has(c.authorId.toString()));
  const storyIds = uniqueIds(comments.map((c) => c.storyId));
  if (!storyIds.length) return out;
  const stories = await FriendStory.find({ _id: { $in: storyIds }, deletedAt: null })
    .select('_id authorId hiddenByReportsAt')
    .lean<{ _id: Types.ObjectId; authorId: Types.ObjectId; hiddenByReportsAt: Date | null }[]>().exec();
  const authors = [...new Set(stories.filter((s) => !s.authorId.equals(me._id) && !blocked.has(s.authorId.toString())).map((s) => s.authorId.toString()))];
  const rows = authors.length ? await friendshipRepository.listBetween(me._id, authors) : [];
  const friends = new Set(rows.filter((r) => r.status === 'accepted').map((r) => otherOf(r, me._id).toString()));
  const storyOk = new Set(stories.filter((s) => s.authorId.equals(me._id) ||
    (!s.hiddenByReportsAt && !blocked.has(s.authorId.toString()) && friends.has(s.authorId.toString()))).map((s) => s._id.toString()));
  for (const c of comments) {
    if (!storyOk.has(c.storyId.toString()) || !seeable(c)) continue;
    if (c.parentId) {
      const root = known.get(c.parentId.toString());
      if (!root || !seeable(root)) continue;
    }
    out.set(c._id.toString(), { storyId: c.storyId.toString(), body: c.body ?? '' });
  }
  return out;
}

async function openableEvents(me: UserDoc, ids: Types.ObjectId[], blocked: ReadonlySet<string>, excerpts: boolean) {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const fields = '_id creatorId inviteeIds hiddenByReportsAt status';
  const events = await FriendEvent.find({ _id: { $in: uniqueIds(ids) }, deletedAt: null })
    .select(excerpts ? `${fields} title` : fields)
    .lean<{ _id: Types.ObjectId; creatorId: Types.ObjectId; inviteeIds: Types.ObjectId[]; hiddenByReportsAt: Date | null; status: string; title?: string }[]>().exec();
  const creators = [...new Set(events.filter((e) => !e.creatorId.equals(me._id) && !blocked.has(e.creatorId.toString())).map((e) => e.creatorId.toString()))];
  const rows = creators.length ? await friendshipRepository.listBetween(me._id, creators) : [];
  const friends = new Set(rows.filter((r) => r.status === 'accepted').map((r) => otherOf(r, me._id).toString()));
  for (const e of events) {
    const mine = e.creatorId.equals(me._id);
    const invited = !blocked.has(e.creatorId.toString()) && !e.hiddenByReportsAt && e.inviteeIds.some((id) => id.equals(me._id)) && friends.has(e.creatorId.toString());
    if (mine || invited) out.set(`${e._id.toString()}:${e.status}`, e.title ?? '');
  }
  return out;
}

/** One ACL path for the feed and badge; display fields are explicitly opt-in. */
async function visible(me: UserDoc, docs: NotificationCandidate[], blocked: ReadonlySet<string>, excerpts: boolean): Promise<Visible[]> {
  if (docs.length === 0) return [];
  const idsFor = (matches: (d: NotificationCandidate) => boolean) => uniqueIds(docs.filter((d) => matches(d) && d.entityId).map((d) => d.entityId as Types.ObjectId));
  const storyIds = idsFor((d) => STORY_TYPES.has(d.type));
  const requestIds = idsFor((d) => d.type === 'friend_request');
  const outingIds = idsFor((d) => OUTING_NOTIFICATION_TYPES.has(d.type));
  const [stories, pending, events, comments, outings] = await Promise.all([
    storyIds.length ? FriendStory.find({ _id: { $in: storyIds }, authorId: me._id, deletedAt: null })
      .select(excerpts ? '_id body' : '_id').lean<{ _id: Types.ObjectId; body?: string }[]>().exec() : [],
    requestIds.length ? friendshipRepository.pendingIncomingIds(me._id, requestIds, blocked) : new Set<string>(),
    openableEvents(me, idsFor((d) => EVENT_NOTIFICATION_TYPES.has(d.type)), blocked, excerpts),
    openableComments(me, idsFor((d) => COMMENT_TYPES.has(d.type)), blocked, excerpts),
    outingIds.length ? friendOutingService.notificationVisibility(me._id.toString(), outingIds.map(String)) : new Map<string, { visible: boolean; restricted: boolean }>(),
  ]);
  const bodyById = new Map(stories.map((s) => [s._id.toString(), s.body ?? '']));
  const allowed = (ids: Types.ObjectId[]) => uniqueIds(ids).filter((id) => !blocked.has(id.toString()));
  const out: Visible[] = [];
  for (const doc of docs) {
    let actorIds = allowed(doc.actorIds);
    // A removed/blocked recent actor must not hide remaining unblocked people in a grouped row.
    let recent = uniqueIds([...allowed(doc.recentActorIds), ...actorIds]).filter((id) => actorIds.some((actor) => actor.equals(id))).slice(0, 3);
    if (!SYSTEM_NOTIFICATION_TYPES.has(doc.type) && (actorIds.length === 0 || recent.length === 0)) continue;
    const entityKey = doc.entityId?.toString();
    let excerpt = '';
    let storyId: string | undefined;
    let restricted: boolean | undefined;
    if (STORY_TYPES.has(doc.type)) {
      const body = entityKey ? bodyById.get(entityKey) : undefined;
      if (body === undefined) continue;
      if (excerpts) excerpt = excerptOf(body);
    }
    if (COMMENT_TYPES.has(doc.type)) {
      const comment = entityKey ? comments.get(entityKey) : undefined;
      if (!comment) continue;
      if (excerpts) excerpt = excerptOf(comment.body);
      storyId = comment.storyId;
    }
    if (EVENT_NOTIFICATION_TYPES.has(doc.type)) {
      const state = doc.type === 'event_cancelled' ? 'cancelled' : 'active';
      const title = entityKey ? events.get(`${entityKey}:${state}`) : undefined;
      if (title === undefined) continue;
      if (excerpts) excerpt = excerptOf(title);
    }
    if (OUTING_NOTIFICATION_TYPES.has(doc.type)) {
      const access = entityKey ? outings.get(entityKey) : undefined;
      if (!access?.visible) continue;
      restricted = access.restricted;
      if (restricted) {
        actorIds = [];
        recent = [];
      }
    }
    if (doc.type === 'friend_request' && (!entityKey || !pending.has(entityKey))) continue;
    out.push({ doc, actorIds, recent, excerpt, storyId, restricted });
  }
  return out;
}

async function toViews(items: Visible[]): Promise<FriendNotificationView[]> {
  const profiles = await profileService.load(uniqueIds(items.flatMap((i) => i.recent)));
  return items.map(({ doc, actorIds, recent, excerpt, storyId, restricted }) => {
    const entityId = doc.entityId?.toString();
    let entity: NotificationEntity = null;
    if (STORY_TYPES.has(doc.type) && entityId) entity = { kind: 'story', id: entityId, excerpt };
    else if (COMMENT_TYPES.has(doc.type) && entityId && storyId) entity = { kind: 'comment', id: entityId, storyId, excerpt };
    else if (EVENT_NOTIFICATION_TYPES.has(doc.type) && entityId) entity = { kind: 'event', id: entityId, excerpt };
    else if (OUTING_NOTIFICATION_TYPES.has(doc.type) && entityId) entity = { kind: 'outing', id: entityId, restricted: restricted ?? false };
    else if (doc.type === 'friend_request' && entityId) entity = { kind: 'request', id: entityId };
    return { id: doc._id.toString(), type: doc.type, actors: recent.map((id) => profileOf(profiles, id)), actorCount: actorIds.length, entity, read: doc.readAt !== null, updatedAt: doc.updatedAt.toISOString() };
  });
}

export const friendNotificationsService = {
  async list(me: UserDoc, cursor: string | undefined) {
    const [docs, blocked] = await Promise.all([
      friendNotificationRepository.list(me._id, decodeCursor(cursor), PAGE),
      friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const page = docs.slice(0, PAGE);
    const nextCursor = docs.length > PAGE ? encodeCursor(page[page.length - 1]) : null;
    return { items: await toViews(await visible(me, page, blocked, true)), nextCursor };
  },

  /**
   * Count visible activity since seen (not readAt). At most 500 raw candidates receive ACL checks,
   * plus one projected lookahead. Stop at 99 visible rows. Saturated means cap reached or more raw
   * candidates remain beyond the work budget; below 99 it is explicitly a lower bound, never a total.
   */
  async unread(me: UserDoc): Promise<{ notifications: number; notificationsSaturated: boolean; friendRequests: number; messages: number }> {
    const [docs, blocked] = await Promise.all([
      friendNotificationRepository.listSince(me._id, me.friendsNotifSeenAt, NOTIFICATION_SCAN_BUDGET + 1),
      friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const friendRequests = await friendshipRepository.countIncomingPending(me._id, blocked);
    const candidates = [...new Map(docs.slice(0, NOTIFICATION_SCAN_BUDGET).map((d) => [d._id.toString(), d])).values()];
    let notifications = 0;
    for (let offset = 0; offset < candidates.length && notifications < MAX_BADGE; offset += VISIBILITY_BATCH) {
      notifications += (await visible(me, candidates.slice(offset, offset + VISIBILITY_BATCH), blocked, false)).length;
    }
    const notificationsSaturated = notifications >= MAX_BADGE || docs.length > NOTIFICATION_SCAN_BUDGET;
    return { notifications: Math.min(notifications, MAX_BADGE), notificationsSaturated, friendRequests, messages: 0 };
  },

  async seen(me: UserDoc): Promise<void> {
    await userRepository.setFriendsNotifSeenAt(me._id, new Date());
    await realtimeAudience.own(me._id.toString(), 'friends', ['friend-notifications']).catch(() => {});
  },

  async read(me: UserDoc, id: string): Promise<void> {
    if (!(await friendNotificationRepository.markRead(me._id, id))) throw Errors.notFound('Thông báo không tồn tại');
    await realtimeAudience.own(me._id.toString(), 'friends', ['friend-notifications']).catch(() => {});
  },

  async readAll(me: UserDoc): Promise<void> {
    await friendNotificationRepository.markAllRead(me._id);
    await realtimeAudience.own(me._id.toString(), 'friends', ['friend-notifications']).catch(() => {});
  },
};
