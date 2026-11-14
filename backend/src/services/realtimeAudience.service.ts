import { Types } from 'mongoose';
import { coupleRepository } from '../repositories/couple.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { friendshipRepository } from '../repositories/friendship.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { friendOutingRepository } from '../repositories/friendOuting.repository.js';
import { realtimeService, type RealtimeDomain, type RealtimeSpace } from './realtime.service.js';

type Id = string | { toString(): string };
type EventAudience = { creatorId: Id; inviteeIds: readonly Id[] };
type OutingAudience = { creatorId: string; participants: readonly { userId: string; status: 'accepted' | 'pending' | 'declined' }[] };
const objectId = (id: Id): Types.ObjectId => new Types.ObjectId(id.toString());

/** Each resolver catches all failures: hint delivery must never alter a committed mutation. */
export const realtimeAudience = {
  async own(userId: Id, space: RealtimeSpace, domains: RealtimeDomain[], access = false): Promise<void> {
    try { realtimeService.publish([userId.toString()], space, domains, access); } catch { /* best effort */ }
  },
  async couple(coupleId: Id, domains: RealtimeDomain[], access = false): Promise<void> {
    try {
      const couple = await coupleRepository.findActiveById(objectId(coupleId));
      if (couple) realtimeService.publish(couple.memberIds.map(String), 'couple', domains, access);
    } catch { /* best effort */ }
  },
  async coupleForUser(userId: Id, domains: RealtimeDomain[], access = false): Promise<void> {
    try {
      const user = await userRepository.findById(userId.toString());
      if (user?.coupleId) await realtimeAudience.couple(user.coupleId, domains, access);
      else realtimeService.publish([userId.toString()], 'couple', domains, access);
    } catch { /* best effort */ }
  },
  async friendsOf(authorId: Id, domains: RealtimeDomain[], access = false): Promise<void> {
    try {
      const id = objectId(authorId);
      const [friends, blocked] = await Promise.all([friendshipRepository.friendIds(id), friendBlockRepository.blockedIdsFor(id)]);
      realtimeService.publish([id.toString(), ...friends.map(String).filter((friend) => !blocked.has(friend))], 'friends', domains, access);
    } catch { /* best effort */ }
  },
  async event(event: EventAudience, domains: RealtimeDomain[], access = false): Promise<void> {
    try {
      const creator = objectId(event.creatorId);
      const [friends, blocked] = await Promise.all([friendshipRepository.friendIds(creator), friendBlockRepository.blockedIdsFor(creator)]);
      const eligible = new Set(friends.map(String));
      const recipients = event.inviteeIds.map(String).filter((id) => eligible.has(id) && !blocked.has(id));
      realtimeService.publish([creator.toString(), ...recipients], 'friends', domains, access);
    } catch { /* best effort */ }
  },
  async outing(outing: OutingAudience, domains: RealtimeDomain[], access = false): Promise<void> {
    try {
      const accepted = outing.participants.filter((p) => p.status === 'accepted').map((p) => p.userId);
      const others = accepted.filter((id) => id !== outing.creatorId);
      const pending = outing.participants.filter((p) => p.status !== 'accepted');
      const recipients = [...accepted];
      if (pending.length) {
        const [friends, blocked] = await Promise.all([
          friendshipRepository.listBetween(outing.creatorId, others), friendOutingRepository.groupHasBlock(accepted),
        ]);
        const restricted = blocked || friends.filter((f) => f.status === 'accepted').length !== others.length;
        if (!restricted) for (const p of pending) {
          if (await friendshipRepository.areFriends(outing.creatorId, p.userId) &&
              !(await friendOutingRepository.groupHasBlock([...new Set([...accepted, p.userId])]))) recipients.push(p.userId);
        }
      }
      realtimeService.publish(recipients, 'friends', domains, access);
    } catch { /* best effort */ }
  },
};
