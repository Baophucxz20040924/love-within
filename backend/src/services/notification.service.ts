import { Types } from 'mongoose';
import { COUPLE_PUSH_RULES, FRIENDS_PUSH_RULES, type CoupleNotificationType } from '../config/notificationTypes.js';
import type { CoupleDoc } from '../models/Couple.js';
import { GROUPED_NOTIFICATION_TYPES, OUTING_NOTIFICATION_TYPES, SYSTEM_NOTIFICATION_TYPES, type FriendNotificationType } from '../models/FriendNotification.js';
import { friendNotificationRepository } from '../repositories/friendNotification.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { logger } from '../utils/logger.js';
import { pushService, type PushContent } from './push.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import type { CoupleNotificationTarget } from '../models/CoupleNotification.js';
import { coupleNotificationRepository } from '../repositories/coupleNotification.repository.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { invalidateCoupleNotifications } from './coupleNotifications.service.js';

const invalidateNotifications = (userId: Types.ObjectId) => realtimeAudience.own(userId.toString(), 'friends', ['friend-notifications']).catch(() => {});

export type NotificationSpace = 'couple' | 'friends';
export type { PushContent };

interface NotifyBase {
  /** Recipient. */
  to: Types.ObjectId;
  /** Post, request, letter… the notification is about. */
  entityId?: Types.ObjectId | null;
}

/** Friends space: stored for the notifications page (BB1), then pushed. The push text comes from the type unless given. */
export interface FriendsNotifyInput extends NotifyBase {
  space: 'friends';
  type: FriendNotificationType;
  /** Who did it; null only for SYSTEM_NOTIFICATION_TYPES (poll_closed, event_reminder: sent by a job). */
  actorId: Types.ObjectId | null;
  /** comment_reply / mention: the post of the comment, for the push link (entityId is then a comment). */
  postId?: Types.ObjectId;
  push?: PushContent;
}

/** Durable Love inbox first, optional push second. Origin and event identity must come from the saved source. */
export interface CoupleNotifyInput extends NotifyBase {
  space: 'couple';
  /** Durable source workers must retry inbox persistence failures. */
  requirePersistence?: boolean;
  coupleId: Types.ObjectId;
  type: CoupleNotificationType;
  actorId: Types.ObjectId | null;
  /** Stable per actual event, including comment IDs, reminder occurrence/slot, or lifecycle identity. */
  eventKey: string;
  target: CoupleNotificationTarget;
  push: PushContent;
}

export type NotifyInput = FriendsNotifyInput | CoupleNotifyInput;

/**
 * Lock-screen text of the friends types when "Hiện nội dung" is on (otherwise "Bạn có thông báo mới"). Never names the
 * friends space. Same meaning as the sentences of the notifications page (frontend FriendsNotificationsPage.tsx).
 */
function friendsPush(n: FriendsNotifyInput): PushContent {
  const actor = n.actorId?.toString() ?? '';
  const post = n.entityId?.toString() ?? '';
  switch (n.type) {
    case 'friend_request':
      return { body: (name) => `${name} đã gửi cho bạn lời mời kết bạn`, url: '/friends/people', tag: 'friend-requests' };
    case 'friend_accepted':
      return { body: (name) => `${name} đã chấp nhận lời mời kết bạn của bạn`, url: `/friends/u/${actor}`, tag: `friend:${actor}` };
    case 'story_reaction':
      return { body: (name) => `${name} đã bày tỏ cảm xúc về bài viết của bạn`, url: `/friends/posts/${post}`, tag: `post:${post}` };
    case 'story_comment':
      return { body: (name) => `${name} đã bình luận về bài viết của bạn`, url: `/friends/posts/${post}`, tag: `post:${post}` };
    case 'invite_joined':
      return { body: (name) => `${name} đã nhận lời mời qua link của bạn. Hai bạn giờ là bạn bè`, url: `/friends/u/${actor}`, tag: `friend:${actor}` };
    case 'comment_reply':
    case 'mention': {
      // entityId = the comment to open (root comment for a reply, the comment with the mention); never its text.
      const postId = n.postId?.toString() ?? '';
      const url = postId ? `/friends/posts/${postId}?comment=${n.entityId?.toString() ?? ''}` : '/friends/notifications';
      const body =
        n.type === 'mention'
          ? (name: string) => `${name} đã nhắc đến bạn trong một bình luận`
          : (name: string) => `${name} đã trả lời bình luận của bạn`;
      return { body, url, tag: postId ? `post:${postId}` : 'friends' };
    }
    case 'post_mention':
      return { body: (name) => `${name} đã nhắc đến bạn trong một bài viết`, url: `/friends/posts/${post}`, tag: `post:${post}` };
    case 'poll_closed':
      return { body: 'Bình chọn của bạn đã kết thúc', url: `/friends/posts/${post}`, tag: `post:${post}` };
    // BB5: entityId = the event. Never the title, the place or a comment (same as posts: only who did what).
    case 'event_invite':
      return { body: (name) => `${name} đã mời bạn tham gia một kèo`, url: `/friends/events/${post}`, tag: `event:${post}` };
    case 'event_rsvp':
      return { body: (name) => `${name} sẽ đi kèo của bạn`, url: `/friends/events/${post}`, tag: `event:${post}` };
    case 'event_changed':
      return { body: (name) => `${name} đã đổi giờ hoặc địa điểm của kèo`, url: `/friends/events/${post}`, tag: `event:${post}` };
    case 'event_cancelled':
      return { body: (name) => `${name} đã hủy một kèo`, url: `/friends/events/${post}`, tag: `event:${post}` };
    case 'event_comment':
      return { body: (name) => `${name} đã bình luận trong một kèo`, url: `/friends/events/${post}`, tag: `event:${post}` };
    case 'event_reminder':
      return { body: 'Còn khoảng 2 giờ nữa là tới kèo của bạn', url: `/friends/events/${post}`, tag: `event:${post}` };
    // Outing lock-screen text is intentionally generic: no names, amounts, notes or group details.
    case 'outing_invite':
    case 'outing_added':
    case 'outing_changed':
    case 'outing_review':
    case 'outing_closed':
    case 'outing_settlement':
    case 'outing_completed':
      return { body: 'Bạn có cập nhật mới về buổi đi chơi', url: `/friends/outings/${post}`, tag: `outing:${post}` };
  }
}

/**
 * Single entry point for notifications (plan/OPERATIONS.md, N3 + N4).
 * - friends: stored for the notifications page (reactions and comments grouped per post), then pushed to the
 *   recipient's friends-space devices only.
 * - couple: an insert-only, couple-scoped event row is stored independently of push preferences/devices.
 * Never pushes to the actor themself, nor between two people who block each other. Push goes through the recipient's
 * settings (group switch, "Hiện nội dung", quiet hours) and is sent in the background.
 * Never throws: a failed notification must not fail the action that caused it.
 */
export const notificationService = {
  async emit(input: NotifyInput): Promise<void> {
    if (input.actorId && input.to.equals(input.actorId)) return;
    const entityId = input.entityId ?? null;

    if (input.space === 'couple') {
      try {
        // Never infer origin from the recipient's *new* couple after unpair/re-pair.
        const [couple, recipient] = await Promise.all([
          coupleRepository.findActiveById(input.coupleId), userRepository.findById(input.to),
        ]);
        if (!couple || !recipient?.coupleId?.equals(input.coupleId) || !couple.memberIds.some((id) => id.equals(input.to)) ||
            (input.actorId && !couple.memberIds.some((id) => id.equals(input.actorId!)))) return;
        const inserted = await coupleNotificationRepository.addOnce({
          userId: input.to, coupleId: input.coupleId, type: input.type, actorId: input.actorId,
          entityId, eventKey: `${input.type}:${input.eventKey}`, target: input.target,
        });
        if (!inserted) return; // A retry neither resets state nor pushes again.
        await invalidateCoupleNotifications(input.to);
        const rule = COUPLE_PUSH_RULES[input.type];
        pushService.enqueue({ userId: input.to, space: 'couple', group: rule.group, type: input.type, actorId: input.actorId, content: input.push, timed: rule.timed, urgent: rule.urgent });
      } catch (err) {
        // A saved photo / approval / monetary action must survive any inbox or push failure.
        logger.warn('Couple notification not delivered', { userId: String(input.to), type: input.type, message: (err as Error).message });
        if (input.requirePersistence) throw err;
      }
      return;
    }

    const rule = FRIENDS_PUSH_RULES[input.type];
    const actorId = input.actorId;
    // Only the server itself may notify without a person (a job): a missing actor on a person's event is a bug.
    if (!actorId && !SYSTEM_NOTIFICATION_TYPES.has(input.type)) {
      logger.warn('Notification without actor ignored', { userId: input.to.toString(), type: input.type });
      return;
    }
    let newActor = true;
    try {
      if (actorId && (await friendBlockRepository.isBlockedBetween(input.to, actorId))) return;
      if (input.type === 'post_mention') {
        if (!actorId || !entityId) return;
        // An existing row must not be bumped, invalidated, or pushed again.
        if (!(await friendNotificationRepository.addPostMentionOnce(input.to, actorId, entityId))) return;
      } else if (actorId && entityId && GROUPED_NOTIFICATION_TYPES.has(input.type)) {
        newActor = await friendNotificationRepository.addGrouped(input.to, input.type, actorId, entityId);
      } else {
        await friendNotificationRepository.add(input.to, input.type, actorId, entityId);
      }
    } catch (err) {
      // Not knowing whether the two block each other: no push either.
      logger.warn('Notification not stored', { userId: input.to.toString(), type: input.type, message: (err as Error).message });
      return;
    }
    await invalidateNotifications(input.to);
    if (rule.onlyNewActor && !newActor) return;
    pushService.enqueue({
      userId: input.to,
      space: 'friends',
      group: rule.group,
      type: input.type,
      // Generic outing push never needs to load the actor's social profile.
      actorId: OUTING_NOTIFICATION_TYPES.has(input.type) ? null : actorId,
      content: OUTING_NOTIFICATION_TYPES.has(input.type) || input.type === 'post_mention' ? friendsPush(input) : input.push ?? friendsPush(input),
      timed: rule.timed,
      urgent: rule.urgent,
    });
  },

  /**
   * Couple app: push to the other member of the couple about what `actorId` just did (nothing when not paired).
   * Never awaited for long and never throws, like emit().
   */
  async toPartner(
    couple: CoupleDoc,
    actorId: string | Types.ObjectId,
    n: Pick<CoupleNotifyInput, 'type' | 'entityId' | 'eventKey' | 'target' | 'push' | 'requirePersistence'>,
  ): Promise<void> {
    try {
      const actor = typeof actorId === 'string' ? new Types.ObjectId(actorId) : actorId;
      if (!couple.memberIds.some((id) => id.equals(actor))) return;
      const to = couple.memberIds.find((m) => !m.equals(actor));
      if (!to) return;
      await notificationService.emit({ ...n, space: 'couple', coupleId: couple._id, to, actorId: actor });
    } catch (err) {
      logger.warn('Couple notification not delivered', { coupleId: String(couple._id), type: n.type, message: (err as Error).message });
      if (n.requirePersistence) throw err;
    }
  },

  /** Unfriend or block: forget what each of the two did for the other. */
  async forgetBetween(a: Types.ObjectId, b: Types.ObjectId): Promise<void> {
    try { await friendNotificationRepository.purgeBetween(a, b); }
    catch (err) { logger.warn('Could not purge notifications', { userId: a.toString(), message: (err as Error).message }); }
    finally { await Promise.all([invalidateNotifications(a), invalidateNotifications(b)]); }
  },

  /** A post was deleted or a friend request answered: its notifications are no longer useful. */
  async forgetEntity(entityId: Types.ObjectId, type?: FriendNotificationType): Promise<void> {
    const owners = await friendNotificationRepository.ownersForEntities([entityId], type).catch(() => [] as Types.ObjectId[]);
    await (type ? friendNotificationRepository.deleteForEntityOfType(entityId, type) : friendNotificationRepository.deleteForEntity(entityId))
      .then(() => Promise.all(owners.map(invalidateNotifications)))
      .catch((err: Error) => logger.warn('Could not delete notifications', { entityId: entityId.toString(), message: err.message }));
  },

  /** Comments were deleted (a root with its replies): replies to them and mentions in them go. */
  async forgetEntities(entityIds: Types.ObjectId[]): Promise<void> {
    if (entityIds.length === 0) return;
    const owners = await friendNotificationRepository.ownersForEntities(entityIds).catch(() => [] as Types.ObjectId[]);
    await friendNotificationRepository.deleteForEntities(entityIds)
      .then(() => Promise.all(owners.map(invalidateNotifications)))
      .catch((err: Error) => logger.warn('Could not delete notifications', { entities: entityIds.length, message: err.message }));
  },

  /** A grouped row no longer holds for one person (BB5: "Đi" taken back): that person leaves the row. */
  async forgetActor(to: Types.ObjectId, type: FriendNotificationType, entityId: Types.ObjectId, actorId: Types.ObjectId): Promise<void> {
    try { await friendNotificationRepository.removeGroupedActor(to, type, entityId, actorId); }
    catch (err) { logger.warn('Could not update notification', { userId: to.toString(), type, message: (err as Error).message }); }
    finally { await invalidateNotifications(to); }
  },
};
