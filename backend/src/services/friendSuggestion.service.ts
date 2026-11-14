import { Types } from 'mongoose';
import { SUGGESTION_DISMISS_DAYS } from '../models/FriendSuggestionDismissal.js';
import type { UserDoc } from '../models/User.js';
import { friendshipRepository, otherOf } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { friendSuggestionRepository } from '../repositories/friendSuggestion.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { profileOf, profileService, type PublicProfile } from './profile.service.js';

export interface FriendSuggestionView {
  user: PublicProfile;
  /** Friends we have in common (people blocked by me excluded). */
  mutualCount: number;
  /** Up to 3 of them. */
  mutualPreview: PublicProfile[];
}

/** Shown at most. */
const MAX_SUGGESTIONS = 20;
/** Ranked candidates kept per user, so filtering at read time still leaves enough. */
const KEEP_CANDIDATES = 50;
/** Mutual friend ids kept per candidate (preview + recount when one of them is no longer my friend). */
const KEEP_MUTUAL_IDS = 20;
/** Friendships of my friends read at most (two ids each, ~2 MB). */
const SCAN_LIMIT = 20_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_USERS = 1000;
const DAY_MS = 86_400_000;
const NOT_MEMBER = 'Không tìm thấy người này trong Hội bạn bè';

interface Candidate {
  id: string;
  count: number;
  mutual: string[];
}

/**
 * Ranked friends of friends per user, for 10 minutes (plan: "nhớ kết quả 10 phút trong RAM", at most 1 000 users).
 * Per process. Never cleared on changes: every read filters again by the latest friends, requests, blocks and dismissals.
 */
const cache = new Map<string, { at: number; candidates: Candidate[] }>();

function cached(userId: string, now: number): Candidate[] | null {
  const hit = cache.get(userId);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return hit.candidates;
}

function remember(userId: string, candidates: Candidate[], now: number): void {
  cache.delete(userId);
  // Map keeps insertion order: the first key is the oldest entry.
  while (cache.size >= CACHE_MAX_USERS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(userId, { at: now, candidates });
}

/**
 * Friends of my friends, ranked by how many of my friends they share with me. One indexed read of the friendships that
 * involve my friends (bounded), counted in memory like the mutual friends of a profile (BB3).
 */
async function rank(me: string, friendIds: Types.ObjectId[]): Promise<Candidate[]> {
  const friends = new Set(friendIds.map((id) => id.toString()));
  const rows = await friendshipRepository.acceptedTouching(friendIds, SCAN_LIMIT);
  const byId = new Map<string, Candidate>();
  const add = (candidate: string, via: string) => {
    if (candidate === me || friends.has(candidate)) return;
    const c = byId.get(candidate) ?? { id: candidate, count: 0, mutual: [] };
    c.count += 1;
    if (c.mutual.length < KEEP_MUTUAL_IDS) c.mutual.push(via);
    byId.set(candidate, c);
  };
  for (const r of rows) {
    const a = r.requesterId.toString();
    const b = r.recipientId.toString();
    // One row per pair, so each row is one mutual friend for the person on the other side.
    if (friends.has(a)) add(b, a);
    if (friends.has(b)) add(a, b);
  }
  if (rows.length >= SCAN_LIMIT) logger.warn('Friend suggestions: scan limit reached', { userId: me, limit: SCAN_LIMIT });
  return [...byId.values()].sort((x, y) => y.count - x.count || (x.id < y.id ? -1 : 1)).slice(0, KEEP_CANDIDATES);
}

/** "Những người bạn có thể biết" (plan/ENGINEERING_WORKFLOW.md, BB7). */
export const friendSuggestionService = {
  /**
   * Up to 20 friends of my friends, most mutual friends first. Never me, my friends, pending requests (either way),
   * people blocked either way, or people I dismissed in the last 90 days. No mutual friend → never suggested, so a
   * stranger never sees a list of members.
   */
  async list(me: UserDoc): Promise<FriendSuggestionView[]> {
    const userId = me._id.toString();
    const now = Date.now();
    const rows = await friendshipRepository.listFor(me._id);
    const friendIds = rows.filter((r) => r.status === 'accepted').map((r) => otherOf(r, me._id));
    if (friendIds.length === 0) return [];
    const pending = new Set(rows.filter((r) => r.status === 'pending').map((r) => otherOf(r, me._id).toString()));
    const friends = new Set(friendIds.map((id) => id.toString()));

    let candidates = cached(userId, now);
    if (!candidates) {
      candidates = await rank(userId, friendIds);
      remember(userId, candidates, now);
    }

    const [blocked, dismissed] = await Promise.all([
      friendBlockRepository.blockedIdsFor(me._id),
      friendSuggestionRepository.activeIds(me._id, new Date(now)),
    ]);
    const picked: Candidate[] = [];
    for (const c of candidates) {
      if (c.id === userId || friends.has(c.id) || pending.has(c.id) || blocked.has(c.id) || dismissed.has(c.id)) continue;
      // Mutual friends I unfriended or blocked since the ranking no longer count.
      const still = c.mutual.filter((id) => friends.has(id) && !blocked.has(id));
      const count = c.count - (c.mutual.length - still.length);
      if (count <= 0 || still.length === 0) continue;
      picked.push({ id: c.id, count, mutual: still });
    }
    picked.sort((x, y) => y.count - x.count);
    const top = picked.slice(0, MAX_SUGGESTIONS);
    if (top.length === 0) return [];

    const ids = top.flatMap((c) => [c.id, ...c.mutual.slice(0, 3)]);
    const profiles = await profileService.load(ids.map((id) => new Types.ObjectId(id)));
    return top.map((c) => ({
      user: profileOf(profiles, c.id),
      mutualCount: c.count,
      mutualPreview: c.mutual.slice(0, 3).map((id) => profileOf(profiles, id)),
    }));
  },

  /** "Xóa": not suggested again for 90 days. Idempotent. */
  async dismiss(me: UserDoc, targetId: string): Promise<{ until: string }> {
    if (me._id.equals(targetId)) throw Errors.badRequest('Không thể ẩn chính mình');
    const target = await userRepository.findById(targetId);
    if (!target || !target.friendsJoinedAt || (await friendBlockRepository.isBlockedBetween(me._id, target._id))) {
      throw Errors.notFound(NOT_MEMBER);
    }
    const until = new Date(Date.now() + SUGGESTION_DISMISS_DAYS * DAY_MS);
    await friendSuggestionRepository.dismiss(me._id, target._id, until);
    logger.info('Friend suggestion dismissed', { userId: me._id.toString(), dismissedId: targetId });
    return { until: until.toISOString() };
  },
};
