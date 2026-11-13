import { Types } from 'mongoose';
import {
  FriendEvent,
  FriendEventComment,
  MAX_EVENT_INVITEES,
  type EventCover,
  type FriendEventCommentDoc,
  type FriendEventDoc,
  type RsvpStatus,
} from '../models/FriendEvent.js';

const alive = { deletedAt: null };

export interface FriendEventInput {
  title: string;
  startAt: Date;
  endAt: Date | null;
  pastAt: Date;
  place: string;
  mapUrl: string | null;
  description: string;
  cover: EventCover | null;
}

/** What notification filtering needs about an event (never shown as such). */
export interface EventBrief {
  _id: Types.ObjectId;
  creatorId: Types.ObjectId;
  inviteeIds: Types.ObjectId[];
  title: string;
  status: 'active' | 'cancelled';
  hiddenByReportsAt: Date | null;
}

/** Job friend-events.remind: who to remind of one event. */
export interface RemindableFriendEvent {
  _id: Types.ObjectId;
  creatorId: Types.ObjectId;
  inviteeIds: Types.ObjectId[];
  rsvps: Record<string, RsvpStatus>;
  startAt: Date;
  hiddenByReportsAt: Date | null;
}

/**
 * Friends-space events (BB5). Who may see an event (creator, or an invitee who is still a friend of the creator) is
 * checked by friendEventService before any read; writes by the creator also require creatorId here.
 */
export const friendEventRepository = {
  create(input: FriendEventInput & { creatorId: Types.ObjectId; inviteeIds: Types.ObjectId[] }): Promise<FriendEventDoc> {
    return FriendEvent.create(input);
  },

  findById(id: string | Types.ObjectId): Promise<FriendEventDoc | null> {
    return FriendEvent.findOne({ _id: id, ...alive }).exec();
  },

  /**
   * My events and the events I am invited to by `creatorIds` (my current friends), upcoming (not over yet, soonest first)
   * or past (over, most recent first). Events hidden after reports only for their creator. At most `limit`.
   */
  listFor(userId: Types.ObjectId, creatorIds: Types.ObjectId[], scope: 'upcoming' | 'past', now: Date, limit: number): Promise<FriendEventDoc[]> {
    const when = scope === 'upcoming' ? { pastAt: { $gt: now } } : { pastAt: { $lte: now } };
    return FriendEvent.find({
      ...alive,
      ...when,
      $or: [{ creatorId: userId }, { inviteeIds: userId, creatorId: { $in: creatorIds }, hiddenByReportsAt: null }],
    })
      .sort(scope === 'upcoming' ? { startAt: 1, _id: 1 } : { startAt: -1, _id: -1 })
      .limit(limit)
      .exec();
  },

  /** Creator only, while active and not over. Returns null when that no longer holds. */
  update(id: string, creatorId: Types.ObjectId, set: Partial<FriendEventInput>, now: Date): Promise<FriendEventDoc | null> {
    return FriendEvent.findOneAndUpdate(
      { _id: id, creatorId, ...alive, status: 'active', pastAt: { $gt: now } },
      { $set: { ...set, editedAt: now } },
      { new: true },
    ).exec();
  },

  /**
   * Add invitees (creator only, active, not over), never above 100 in all: the cap is checked in the same update, so two
   * invites at once cannot pass it. Returns null when a condition fails.
   */
  addInvitees(id: string, creatorId: Types.ObjectId, ids: Types.ObjectId[], now: Date): Promise<FriendEventDoc | null> {
    return FriendEvent.findOneAndUpdate(
      {
        _id: id,
        creatorId,
        ...alive,
        status: 'active',
        pastAt: { $gt: now },
        $expr: { $lte: [{ $size: { $setUnion: ['$inviteeIds', ids] } }, MAX_EVENT_INVITEES] },
      },
      { $addToSet: { inviteeIds: { $each: ids } } },
      { new: true },
    ).exec();
  },

  /** My answer, atomically on my own key; only an invitee of an active event that is not over. */
  setRsvp(id: string, userId: Types.ObjectId, status: RsvpStatus, now: Date): Promise<FriendEventDoc | null> {
    return FriendEvent.findOneAndUpdate(
      { _id: id, ...alive, status: 'active', pastAt: { $gt: now }, inviteeIds: userId },
      { $set: { [`rsvps.${userId.toString()}`]: status } },
      { new: true },
    ).exec();
  },

  /** Active → cancelled once (creator only, not over). */
  cancel(id: string, creatorId: Types.ObjectId, now: Date): Promise<FriendEventDoc | null> {
    return FriendEvent.findOneAndUpdate(
      { _id: id, creatorId, ...alive, status: 'active', pastAt: { $gt: now } },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { new: true },
    ).exec();
  },

  softDelete(id: string, creatorId: Types.ObjectId): Promise<FriendEventDoc | null> {
    return FriendEvent.findOneAndUpdate({ _id: id, creatorId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  async incCommentCount(id: Types.ObjectId): Promise<void> {
    await FriendEvent.updateOne({ _id: id }, { $inc: { commentCount: 1 } }).exec();
  },

  /** Lower the count by `n` (a root comment and its replies), never below 0. */
  async decCommentCount(id: Types.ObjectId, n: number): Promise<void> {
    if (n <= 0) return;
    await FriendEvent.collection.updateOne({ _id: id }, [
      { $set: { commentCount: { $max: [0, { $subtract: [{ $ifNull: ['$commentCount', 0] }, n] }] } } },
    ]);
  },

  /** Live events among `ids` (notification filtering and excerpts). */
  findBriefs(ids: Types.ObjectId[]): Promise<EventBrief[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return FriendEvent.find({ _id: { $in: ids }, ...alive })
      .select('creatorId inviteeIds title status hiddenByReportsAt')
      .lean<EventBrief[]>()
      .exec();
  },

  /** Job: active, live events starting in (from, to], soonest first, at most `limit`. */
  listStartingBetween(from: Date, to: Date, limit: number): Promise<RemindableFriendEvent[]> {
    return FriendEvent.find({ status: 'active', startAt: { $gt: from, $lte: to }, ...alive })
      .sort({ startAt: 1 })
      .limit(limit)
      .select('creatorId inviteeIds rsvps startAt hiddenByReportsAt')
      .lean<RemindableFriendEvent[]>()
      .exec();
  },

  async hideByReports(id: Types.ObjectId): Promise<boolean> {
    const res = await FriendEvent.updateOne({ _id: id, hiddenByReportsAt: null }, { $set: { hiddenByReportsAt: new Date() } }).exec();
    return res.modifiedCount > 0;
  },
};

const notHiddenFor = (viewerId: Types.ObjectId) => ({ $or: [{ hiddenByReportsAt: null }, { authorId: viewerId }] });

export const friendEventCommentRepository = {
  create(input: { eventId: Types.ObjectId; authorId: Types.ObjectId; parentId: Types.ObjectId | null; body: string }): Promise<FriendEventCommentDoc> {
    return FriendEventComment.create(input);
  },

  /** Oldest first, roots and replies together, at most 500; without people blocked either way and hidden ones (except mine). */
  list(eventId: Types.ObjectId, viewerId: Types.ObjectId, excludeAuthorIds: Types.ObjectId[]): Promise<FriendEventCommentDoc[]> {
    const filter: Record<string, unknown> = { eventId, ...alive, ...notHiddenFor(viewerId) };
    if (excludeAuthorIds.length) filter.authorId = { $nin: excludeAuthorIds };
    return FriendEventComment.find(filter).sort({ createdAt: 1 }).limit(500).exec();
  },

  findById(eventId: Types.ObjectId, id: string | Types.ObjectId): Promise<FriendEventCommentDoc | null> {
    return FriendEventComment.findOne({ _id: id, eventId, ...alive }).exec();
  },

  /** By id alone (reports name a comment without its event). */
  findAnyById(id: string | Types.ObjectId): Promise<FriendEventCommentDoc | null> {
    return FriendEventComment.findOne({ _id: id, ...alive }).exec();
  },

  softDelete(eventId: Types.ObjectId, id: Types.ObjectId): Promise<FriendEventCommentDoc | null> {
    return FriendEventComment.findOneAndUpdate({ _id: id, eventId, ...alive }, { $set: { deletedAt: new Date() } }, { new: true }).exec();
  },

  /** A root comment was deleted: its live replies go with it (how many this call deleted, to fix the count). */
  async softDeleteReplies(eventId: Types.ObjectId, rootId: Types.ObjectId): Promise<number> {
    const res = await FriendEventComment.updateMany({ eventId, parentId: rootId, ...alive }, { $set: { deletedAt: new Date() } }).exec();
    return res.modifiedCount;
  },

  async hideByReports(id: Types.ObjectId): Promise<boolean> {
    const res = await FriendEventComment.updateOne({ _id: id, hiddenByReportsAt: null }, { $set: { hiddenByReportsAt: new Date() } }).exec();
    return res.modifiedCount > 0;
  },
};
