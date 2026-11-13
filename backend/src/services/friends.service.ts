import { Types } from 'mongoose';
import type { FriendshipDoc } from '../models/Friendship.js';
import type { UserDoc } from '../models/User.js';
import { friendshipRepository, otherOf } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { friendInviteService, type InviteRedeemResult } from './friendInvite.service.js';
import { notificationService } from './notification.service.js';
import { avatarUrlOf, profileOf, profileService, type PublicProfile } from './profile.service.js';

/** How the caller relates to another member. incoming = they sent me a request; outgoing = I sent one. */
export type FriendRelation = 'none' | 'friend' | 'incoming' | 'outgoing' | 'self';

export interface FriendRequestView {
  id: string;
  user: PublicProfile;
  createdAt: string;
}

export interface FriendsOverview {
  friends: { user: PublicProfile; since: string }[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export interface PersonView {
  user: PublicProfile;
  relation: FriendRelation;
  /** Pending request between us (to accept, decline or cancel), else null. */
  requestId: string | null;
}

export interface ProfileView {
  user: PublicProfile & { bio: string };
  relation: FriendRelation;
  requestId: string | null;
  friendCount: number;
  /** Friends we have in common (people blocked by me excluded); preview = up to 3. */
  mutual: { count: number; preview: PublicProfile[] };
  /** Self or friend: may see the posts and the friend list. */
  canSeePosts: boolean;
}

const SEARCH_LIMIT = 20;
const FRIENDS_PAGE = 50;
const NOT_MEMBER = 'Không tìm thấy người này trong Hội bạn bè';

/** "Nguyễn Thu Hà" → "nguyen thu ha": search ignores case and Vietnamese diacritics. */
export function searchNameOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const toObjectIds = (ids: Iterable<string>) => [...ids].map((id) => new Types.ObjectId(id));

function relationOf(f: FriendshipDoc | null | undefined, userId: Types.ObjectId): FriendRelation {
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friend';
  return f.requesterId.equals(userId) ? 'outgoing' : 'incoming';
}

function personView(user: PublicProfile, f: FriendshipDoc | null | undefined, me: Types.ObjectId): PersonView {
  return {
    user,
    relation: relationOf(f, me),
    requestId: f && f.status === 'pending' ? f._id.toString() : null,
  };
}

const byName = (a: { user: PublicProfile }, b: { user: PublicProfile }) => a.user.displayName.localeCompare(b.user.displayName, 'vi');

/** A member the caller may interact with: exists, joined the friends space, no block either way. */
async function requireReachable(me: UserDoc, userId: string): Promise<UserDoc> {
  const user = await userRepository.findById(userId);
  if (!user || !user.friendsJoinedAt || (await friendBlockRepository.isBlockedBetween(me._id, user._id))) {
    throw Errors.notFound(NOT_MEMBER);
  }
  return user;
}

export const friendsService = {
  /**
   * Enter the friends space (hidden login). Idempotent: keeps the first join time and refreshes the search
   * name. With an invite code (link /j/<code>), also becomes friends with the inviter.
   */
  async join(userId: string, inviteCode?: string): Promise<{ joinedAt: string; invite?: InviteRedeemResult }> {
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');
    const joinedAt = user.friendsJoinedAt ?? new Date();
    await userRepository.setFriendsMember(user._id, joinedAt, searchNameOf(user.displayName));
    if (!user.friendsJoinedAt) logger.info('User joined friends space', { userId, viaInvite: Boolean(inviteCode) });
    const result: { joinedAt: string; invite?: InviteRedeemResult } = { joinedAt: joinedAt.toISOString() };
    if (inviteCode) result.invite = await friendInviteService.redeem(user, inviteCode);
    return result;
  },

  /** Friends (A→Z), requests I received and requests I sent (newest first). */
  async overview(me: UserDoc): Promise<FriendsOverview> {
    const [allRows, blocked] = await Promise.all([
      friendshipRepository.listFor(me._id),
      friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const rows = allRows.filter((r) => !blocked.has(otherOf(r, me._id).toString()));
    const profiles = await profileService.load(rows.map((r) => otherOf(r, me._id)));
    const request = (r: FriendshipDoc): FriendRequestView => ({
      id: r._id.toString(),
      user: profileOf(profiles, otherOf(r, me._id)),
      createdAt: r.createdAt.toISOString(),
    });
    const newestFirst = (a: FriendshipDoc, b: FriendshipDoc) => b.createdAt.getTime() - a.createdAt.getTime();

    const pending = rows.filter((r) => r.status === 'pending').sort(newestFirst);
    return {
      friends: rows
        .filter((r) => r.status === 'accepted')
        .map((r) => ({ user: profileOf(profiles, otherOf(r, me._id)), since: (r.acceptedAt ?? r.updatedAt).toISOString() }))
        .sort(byName),
      incoming: pending.filter((r) => r.recipientId.equals(me._id)).map(request),
      outgoing: pending.filter((r) => r.requesterId.equals(me._id)).map(request),
    };
  },

  /** Members whose name contains `q` (diacritics ignored), or whose email is exactly `q` when it contains "@". */
  async search(me: UserDoc, q: string): Promise<PersonView[]> {
    const text = q.trim();
    const exclude = [me._id, ...toObjectIds(await friendBlockRepository.blockedIdsFor(me._id))];
    let users: { _id: Types.ObjectId; displayName: string; avatarKey: string | null }[];
    if (text.includes('@')) {
      users = await userRepository.searchFriendsMembers({ email: text }, exclude, SEARCH_LIMIT);
    } else {
      const name = searchNameOf(text);
      if (!name) return [];
      users = await userRepository.searchFriendsMembers({ namePattern: escapeRegex(name) }, exclude, SEARCH_LIMIT);
    }
    const rows = await friendshipRepository.listBetween(me._id, users.map((u) => u._id));
    const byOther = new Map(rows.map((r) => [otherOf(r, me._id).toString(), r]));
    return Promise.all(users.map(async (u) => personView(await profileService.of(u), byOther.get(u._id.toString()), me._id)));
  },

  /**
   * Send a friend request. If the other person already sent me one, this accepts it instead
   * (both want to be friends). The unique pair index stops duplicates under concurrent taps.
   */
  async sendRequest(me: UserDoc, targetId: string): Promise<PersonView> {
    if (me._id.equals(targetId)) throw Errors.badRequest('Không thể kết bạn với chính mình');
    const target = await requireReachable(me, targetId);
    const targetProfile = await profileService.of(target);

    const existing = await friendshipRepository.findBetween(me._id, target._id);
    if (existing?.status === 'accepted') throw Errors.conflict('Hai bạn đã là bạn bè');
    if (existing && existing.requesterId.equals(me._id)) throw Errors.conflict('Bạn đã gửi lời mời cho người này rồi');

    if (existing) {
      const accepted = await friendshipRepository.accept(existing._id, me._id);
      if (!accepted) throw Errors.conflict('Lời mời vừa thay đổi, tải lại trang nhé');
      await notificationService.forgetEntity(existing._id);
      await notificationService.emit({ space: 'friends', to: target._id, type: 'friend_accepted', actorId: me._id });
      logger.info('Friend request accepted (mutual)', { userId: me._id.toString(), friendId: targetId });
      return personView(targetProfile, accepted, me._id);
    }

    try {
      const created = await friendshipRepository.create(me._id, target._id);
      await notificationService.emit({ space: 'friends', to: target._id, type: 'friend_request', actorId: me._id, entityId: created._id });
      logger.info('Friend request sent', { userId: me._id.toString(), toUserId: targetId, requestId: created._id.toString() });
      return personView(targetProfile, created, me._id);
    } catch (err) {
      if (isDuplicateKey(err)) throw Errors.conflict('Đã có lời mời giữa hai bạn, tải lại trang nhé');
      throw err;
    }
  },

  /** Recipient only. */
  async accept(me: UserDoc, requestId: string): Promise<PersonView> {
    const pending = await friendshipRepository.findPendingForRecipient(requestId, me._id);
    if (!pending || (await friendBlockRepository.isBlockedBetween(me._id, pending.requesterId))) {
      throw Errors.notFound('Lời mời không tồn tại hoặc đã được xử lý');
    }
    const accepted = await friendshipRepository.accept(requestId, me._id);
    if (!accepted) throw Errors.notFound('Lời mời không tồn tại hoặc đã được xử lý');
    const other = otherOf(accepted, me._id);
    await notificationService.forgetEntity(accepted._id);
    await notificationService.emit({ space: 'friends', to: other, type: 'friend_accepted', actorId: me._id });
    logger.info('Friend request accepted', { userId: me._id.toString(), friendId: other.toString(), requestId });
    return personView(profileOf(await profileService.load([other]), other), accepted, me._id);
  },

  /** Decline (recipient) or cancel (requester) a pending request. */
  async removeRequest(me: UserDoc, requestId: string): Promise<void> {
    const deleted = await friendshipRepository.deletePending(requestId, me._id);
    if (!deleted) throw Errors.notFound('Lời mời không tồn tại hoặc đã được xử lý');
    await notificationService.forgetEntity(deleted._id);
    const action = deleted.requesterId.equals(me._id) ? 'cancelled' : 'declined';
    logger.info(`Friend request ${action}`, { userId: me._id.toString(), requestId });
  },

  async unfriend(me: UserDoc, friendId: string): Promise<void> {
    const deleted = await friendshipRepository.deleteAccepted(me._id, friendId);
    if (!deleted) throw Errors.notFound('Hai bạn không phải bạn bè');
    await notificationService.forgetBetween(me._id, otherOf(deleted, me._id));
    logger.info('Unfriended', { userId: me._id.toString(), friendId });
  },

  /** Profile page header (BB3). Strangers see name, photo, bio and mutual friends; posts need friendship. */
  async profile(me: UserDoc, userId: string): Promise<ProfileView> {
    const isMe = me._id.equals(userId);
    const user = isMe ? me : await requireReachable(me, userId);
    const [row, mine, theirs, blocked] = await Promise.all([
      isMe ? Promise.resolve(null) : friendshipRepository.findBetween(me._id, user._id),
      friendshipRepository.friendIds(me._id),
      isMe ? Promise.resolve([] as Types.ObjectId[]) : friendshipRepository.friendIds(user._id),
      friendBlockRepository.blockedIdsFor(me._id),
    ]);
    const relation: FriendRelation = isMe ? 'self' : relationOf(row, me._id);
    const mineSet = new Set(mine.map((id) => id.toString()));
    const mutualIds = theirs.filter((id) => mineSet.has(id.toString()) && !blocked.has(id.toString()));
    const preview = mutualIds.slice(0, 3);
    const profiles = await profileService.load(preview);
    return {
      user: { ...(await profileService.of(user)), bio: user.friendsBio ?? '' },
      relation,
      requestId: row && row.status === 'pending' ? row._id.toString() : null,
      friendCount: isMe ? mine.length : theirs.length,
      mutual: { count: mutualIds.length, preview: preview.map((id) => profileOf(profiles, id)) },
      canSeePosts: isMe || relation === 'friend',
    };
  },

  /** Someone's friend list (A→Z, 50 per page): only for that person and their friends. */
  async friendsOf(me: UserDoc, userId: string, offset: number) {
    const target = new Types.ObjectId(userId);
    if (!target.equals(me._id)) {
      await requireReachable(me, userId);
      if (!(await friendshipRepository.areFriends(me._id, target))) {
        throw new AppError(403, 'NOT_FRIENDS', 'Kết bạn để xem bạn bè của người này');
      }
    }
    const [ids, blocked] = await Promise.all([friendshipRepository.friendIds(target), friendBlockRepository.blockedIdsFor(me._id)]);
    const visible = ids.filter((id) => !blocked.has(id.toString()));
    // Names first (one query) to sort, then sign photo URLs for this page only.
    const rows = await userRepository.findProfiles(visible);
    const sorted = visible
      .map((id) => ({ id: id.toString(), displayName: rows.get(id.toString())?.displayName ?? 'Người dùng', avatarKey: rows.get(id.toString())?.avatarKey ?? null }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
    const page = sorted.slice(offset, offset + FRIENDS_PAGE);
    const items: PublicProfile[] = await Promise.all(
      page.map(async (p) => ({ id: p.id, displayName: p.displayName, avatarUrl: await avatarUrlOf(p.avatarKey) })),
    );
    const next = offset + FRIENDS_PAGE;
    return { items, total: sorted.length, nextOffset: next < sorted.length ? next : null };
  },

  async updateMe(me: UserDoc, input: { bio: string }): Promise<{ bio: string }> {
    const bio = input.bio.trim();
    await userRepository.setFriendsBio(me._id, bio);
    return { bio };
  },
};
