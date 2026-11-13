import { Types } from 'mongoose';
import { userRepository } from '../repositories/user.repository.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { pairingInviteRepository } from '../repositories/pairingInvite.repository.js';
import type { PairingInviteDoc } from '../models/PairingInvite.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const INVITE_TTL_DAYS = 7;

export interface InviteView {
  id: string;
  fromUserId: string;
  fromDisplayName: string | null;
  toEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  direction: 'sent' | 'received';
}

async function toView(inv: PairingInviteDoc, direction: 'sent' | 'received'): Promise<InviteView> {
  const from = await userRepository.findById(inv.fromUserId);
  return {
    id: inv._id.toString(),
    fromUserId: inv.fromUserId.toString(),
    fromDisplayName: from?.displayName ?? null,
    toEmail: inv.toEmail,
    status: inv.status,
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    direction,
  };
}

function isExpired(inv: PairingInviteDoc): boolean {
  return inv.expiresAt.getTime() < Date.now();
}

/** "bob@example.com" → "b***@example.com": enough to debug, without storing the address in logs. */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

export const pairingService = {
  /**
   * Send an invite to an email. The recipient does not need an account yet:
   * invites are keyed by email and surface in GET /pairing/invites after signup.
   */
  async invite(fromUserId: string, toEmail: string): Promise<InviteView> {
    const from = await userRepository.findById(fromUserId);
    if (!from) throw Errors.unauthorized();
    if (from.coupleId) throw Errors.conflict('Bạn đã thuộc một couple');

    const email = toEmail.toLowerCase().trim();
    if (email === from.email) throw Errors.badRequest('Không thể tự mời chính mình');

    const target = await userRepository.findByEmail(email);
    if (target?.coupleId) throw Errors.conflict('Người này đã thuộc một couple khác');

    const dup = await pairingInviteRepository.findPendingBetween(from._id, email);
    if (dup && !isExpired(dup)) throw Errors.conflict('Đã có lời mời đang chờ tới email này');

    const inv = await pairingInviteRepository.create({
      fromUserId: from._id,
      toEmail: email,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    });
    logger.info('Pairing invite sent', { userId: fromUserId, toEmail: maskEmail(email), inviteId: inv._id.toString() });
    return toView(inv, 'sent');
  },

  async listInvites(userId: string): Promise<InviteView[]> {
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized();
    const [sent, received] = await Promise.all([
      pairingInviteRepository.findPendingSentBy(user._id),
      pairingInviteRepository.findPendingReceivedBy(user.email),
    ]);
    const views = await Promise.all([
      ...sent.map((i) => toView(i, 'sent')),
      ...received.map((i) => toView(i, 'received')),
    ]);
    return views;
  },

  async accept(userId: string, inviteId: string): Promise<{ coupleId: string }> {
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized();
    if (user.coupleId) throw Errors.conflict('Bạn đã thuộc một couple');

    const inv = await pairingInviteRepository.findById(inviteId);
    if (!inv || inv.toEmail !== user.email) throw Errors.notFound('Lời mời không tồn tại');
    if (inv.status !== 'pending') throw Errors.conflict('Lời mời không còn hiệu lực');
    if (isExpired(inv)) {
      await pairingInviteRepository.setStatus(inv._id, 'expired');
      throw Errors.conflict('Lời mời đã hết hạn');
    }

    const from = await userRepository.findById(inv.fromUserId);
    if (!from) throw Errors.notFound('Người gửi không tồn tại');
    if (from.coupleId) {
      await pairingInviteRepository.setStatus(inv._id, 'cancelled');
      throw Errors.conflict('Người gửi đã thuộc một couple khác');
    }

    const couple = await coupleRepository.create({
      memberIds: [from._id, user._id],
      timezone: from.timezone,
    });
    await Promise.all([
      userRepository.setCoupleId(from._id, couple._id),
      userRepository.setCoupleId(user._id, couple._id),
      pairingInviteRepository.setStatus(inv._id, 'accepted'),
    ]);
    await pairingInviteRepository.cancelPendingFor([from._id, user._id], [from.email, user.email]);

    logger.info('Couple created', {
      coupleId: couple._id.toString(),
      userId,
      partnerId: from._id.toString(),
    });
    return { coupleId: couple._id.toString() };
  },

  async reject(userId: string, inviteId: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized();
    const inv = await pairingInviteRepository.findById(inviteId);
    if (!inv || inv.toEmail !== user.email) throw Errors.notFound('Lời mời không tồn tại');
    if (inv.status !== 'pending') throw Errors.conflict('Lời mời không còn hiệu lực');
    await pairingInviteRepository.setStatus(inv._id, 'rejected');
    logger.info('Pairing invite rejected', { userId, inviteId });
  },

  async cancel(userId: string, inviteId: string): Promise<void> {
    const inv = await pairingInviteRepository.findById(inviteId);
    if (!inv || inv.fromUserId.toString() !== userId) throw Errors.notFound('Lời mời không tồn tại');
    if (inv.status !== 'pending') throw Errors.conflict('Lời mời không còn hiệu lực');
    await pairingInviteRepository.setStatus(inv._id, 'cancelled');
    logger.info('Pairing invite cancelled', { userId, inviteId });
  },

  /**
   * ADMIN-ONLY (not exposed to members): archive the couple and detach both members.
   * Members cannot unpair themselves; the owner's future admin tool will call this.
   */
  async unpair(userId: string, coupleId: Types.ObjectId, confirm: boolean): Promise<void> {
    if (!confirm) throw Errors.badRequest('Cần xác nhận hủy ghép đôi (confirm=true)');
    const couple = await coupleRepository.findActiveById(coupleId);
    if (!couple) throw Errors.notFound('Couple không tồn tại');
    await coupleRepository.archive(couple._id);
    await Promise.all(couple.memberIds.map((id) => userRepository.setCoupleId(id, null)));
    logger.warn('Couple unpaired (archived)', { coupleId: coupleId.toString(), userId });
  },
};
