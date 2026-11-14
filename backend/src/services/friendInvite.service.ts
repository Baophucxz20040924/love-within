import { randomBytes } from 'node:crypto';
import { INVITE_CODE_LENGTH, type FriendInviteDoc } from '../models/FriendInvite.js';
import type { UserDoc } from '../models/User.js';
import { friendInviteRepository } from '../repositories/friendInvite.repository.js';
import { friendshipRepository } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { notificationService } from './notification.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import { captureRelationshipAudience, invalidateRelationshipAudience } from './friendOuting.service.js';
import { profileService, type PublicProfile } from './profile.service.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_RE = new RegExp(`^[0-9A-Za-z]{${INVITE_CODE_LENGTH}}$`);

/** Unbiased base62 from random bytes: bytes ≥ 248 (4 × 62) are skipped. 10 characters ≈ 59 bits. */
function newCode(): string {
  let out = '';
  while (out.length < INVITE_CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < 248 && out.length < INVITE_CODE_LENGTH) out += ALPHABET[b % 62];
    }
  }
  return out;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface InviteView {
  id: string;
  code: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  status: InviteStatus;
}

/** friended = now friends with the inviter; invalid = expired, used up, revoked or unknown (never says which). */
export type InviteRedeemStatus = 'friended' | 'already_friends' | 'self' | 'invalid';

export interface InviteRedeemResult {
  status: InviteRedeemStatus;
  inviter?: PublicProfile;
}

/** What the public landing page may show: no id, no email. */
export interface InvitePreview {
  valid: boolean;
  inviter?: { displayName: string; avatarUrl: string | null };
}

function statusOf(inv: FriendInviteDoc, now = new Date()): InviteStatus {
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (inv.uses >= inv.maxUses) return 'used_up';
  return 'active';
}

function toView(inv: FriendInviteDoc): InviteView {
  return {
    id: inv._id.toString(),
    code: inv.code,
    maxUses: inv.maxUses,
    uses: inv.uses,
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    status: statusOf(inv),
  };
}

/** Invite links into the friends space (plan/ENGINEERING_WORKFLOW.md, BB4). */
export const friendInviteService = {
  async create(me: UserDoc, days: number, maxUses: number): Promise<InviteView> {
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const inv = await friendInviteRepository.create({ code: newCode(), inviterId: me._id, maxUses, expiresAt });
        await realtimeAudience.own(me._id.toString(), 'friends', ['friends']).catch(() => {});
        logger.info('Friend invite created', { userId: me._id.toString(), inviteId: inv._id.toString(), days, maxUses });
        return toView(inv);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    throw Errors.internal('Không tạo được link mời, thử lại nhé');
  },

  async list(me: UserDoc): Promise<InviteView[]> {
    return (await friendInviteRepository.listByInviter(me._id)).map(toView);
  },

  async revoke(me: UserDoc, id: string): Promise<InviteView> {
    const inv = await friendInviteRepository.revoke(id, me._id);
    if (!inv) throw Errors.notFound('Link mời không tồn tại hoặc đã bị thu hồi');
    await realtimeAudience.own(me._id.toString(), 'friends', ['friends']).catch(() => {});
    logger.info('Friend invite revoked', { userId: me._id.toString(), inviteId: id });
    return toView(inv);
  },

  /** Public (no login): who invites. Never tells why a link is invalid. */
  async preview(code: string): Promise<InvitePreview> {
    if (!CODE_RE.test(code)) return { valid: false };
    const inv = await friendInviteRepository.findByCode(code);
    if (!inv || statusOf(inv) !== 'active') return { valid: false };
    const inviter = await userRepository.findById(inv.inviterId);
    if (!inviter?.friendsJoinedAt) return { valid: false };
    const { displayName, avatarUrl } = await profileService.of(inviter);
    return { valid: true, inviter: { displayName, avatarUrl } };
  },

  /**
   * Called when someone joins through a link: they become friends with the inviter (sharing the link was the
   * inviter's consent, using it is the guest's). A person counts once per link; the use counter only moves while
   * the link is still valid, atomically. A block between the two is never revealed: the link just looks invalid.
   */
  async redeem(me: UserDoc, code: string): Promise<InviteRedeemResult> {
    if (!CODE_RE.test(code)) return { status: 'invalid' };
    const inv = await friendInviteRepository.findByCode(code);
    if (!inv) return { status: 'invalid' };
    if (inv.inviterId.equals(me._id)) return { status: 'self' };
    const inviter = await userRepository.findById(inv.inviterId);
    if (!inviter?.friendsJoinedAt || (await friendBlockRepository.isBlockedBetween(me._id, inviter._id))) {
      return { status: 'invalid' };
    }
    const inviterProfile = await profileService.of(inviter);
    const existing = await friendshipRepository.findBetween(me._id, inviter._id);
    if (existing?.status === 'accepted') return { status: 'already_friends', inviter: inviterProfile };

    const audience = await captureRelationshipAudience(me._id.toString(), inviter._id.toString());
    const firstUse = await friendInviteRepository.recordUse(inv._id, me._id);
    if (firstUse) {
      if (!(await friendInviteRepository.takeSeat(inv._id, new Date()))) {
        await friendInviteRepository.forgetUse(inv._id, me._id);
        return { status: 'invalid' };
      }
      await realtimeAudience.own(inviter._id.toString(), 'friends', ['friends']).catch(() => {});
    } else if (inv.revokedAt || inv.expiresAt.getTime() <= Date.now()) {
      // Used this link before (and has since unfriended): allowed again only while the link is alive.
      return { status: 'invalid' };
    }

    // A request already waiting (either way) becomes the friendship; otherwise create it.
    if (existing && await friendshipRepository.acceptAny(existing._id)) invalidateRelationshipAudience(audience);
    if (!(await friendshipRepository.areFriends(me._id, inviter._id))) {
      try {
        await friendshipRepository.createAccepted(inviter._id, me._id);
        invalidateRelationshipAudience(audience);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const row = await friendshipRepository.findBetween(me._id, inviter._id);
        if (row && await friendshipRepository.acceptAny(row._id)) invalidateRelationshipAudience(audience);
      }
    }
    if (existing) await notificationService.forgetEntity(existing._id);
    await notificationService.emit({ space: 'friends', to: inviter._id, type: 'invite_joined', actorId: me._id });
    logger.info('Friend invite used', { userId: me._id.toString(), inviterId: inviter._id.toString(), inviteId: inv._id.toString() });
    return { status: 'friended', inviter: inviterProfile };
  },
};
