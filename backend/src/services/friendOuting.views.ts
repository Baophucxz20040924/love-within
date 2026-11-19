import type { UserDoc } from '../models/User.js';
import { OUTING_LIMITS, type FriendOutingRecord, type OutingParticipant } from '../models/FriendOuting.js';
import { friendOutingRepository, type OutingHeader } from '../repositories/friendOuting.repository.js';
import { friendshipRepository, pairKeyOf } from '../repositories/friendship.repository.js';
import { Errors } from '../utils/errors.js';
import { friendEventService } from './friendEvent.service.js';
import { outingBalances, suggestTransfers } from './friendExpenseMath.js';

export type OutingAccess = 'invited' | 'declined' | 'full' | 'restricted';
export async function outingRestricted(doc: Pick<OutingHeader, 'creatorId' | 'participants'>): Promise<boolean> {
  // Only accepted members have financial obligations. A stale pending invitation must
  // not freeze the accepted ledger; its eligibility is checked separately below.
  const active = doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId);
  const others = active.filter((id) => id !== doc.creatorId);
  const [friends, blocked] = await Promise.all([
    friendshipRepository.listBetween(doc.creatorId, others), friendOutingRepository.groupHasBlock(active),
  ]);
  return blocked || friends.filter((f) => f.status === 'accepted').length !== others.length;
}
/** Pending access and acceptance must remain eligible against the prospective accepted roster.
 * Blocks are checked independently of friendship, including interrupted block cleanup.
 * These live relationship reads are not a cross-collection transaction with the ledger CAS.
 */
export async function outingInvitationEligible(doc: Pick<OutingHeader, 'creatorId' | 'participants'>, userId: string): Promise<boolean> {
  const prospectiveIds = [...new Set([...doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId), userId])];
  const [friends, blocked, restricted] = await Promise.all([
    friendshipRepository.areFriends(doc.creatorId, userId),
    friendOutingRepository.groupHasBlock(prospectiveIds),
    outingRestricted(doc),
  ]);
  return friends && !blocked && !restricted;
}
/** Historical membership is authoritative for money, never the live event's filtered guest list. */
export async function outingAccess(doc: OutingHeader, userId: string): Promise<OutingAccess> {
  const member = doc.participants.find((p) => p.userId === userId);
  if (!member) throw Errors.notFound('Buổi chia tiền không tồn tại');
  if (member.status !== 'accepted') {
    if (!(await outingInvitationEligible(doc, userId))) throw Errors.notFound('Buổi chia tiền không tồn tại');
    return member.status === 'pending' ? 'invited' : 'declined';
  }
  return await outingRestricted(doc) ? 'restricted' : 'full';
}
/** List-only request snapshot. Never reuse for detail, mutation, replay or postcommit authorization. */
export async function outingListAccess(page: readonly OutingHeader[], userId: string): Promise<Map<string, OutingAccess>> {
  const pairs: [string, string][] = [], rosters: string[][] = [];
  const candidates = page.map(doc => {
    const member = doc.participants.find(p => p.userId === userId);
    const active = [...new Set(doc.participants.filter(p => p.status === 'accepted').map(p => p.userId))];
    const others = active.filter(id => id !== doc.creatorId);
    pairs.push(...others.map(id => [doc.creatorId, id] as [string, string]));
    const activeIndex = rosters.push(active) - 1;
    let prospectiveIndex = activeIndex;
    if (member && member.status !== 'accepted') {
      pairs.push([doc.creatorId, userId]);
      prospectiveIndex = rosters.push([...new Set([...active, userId])]) - 1;
    }
    return { doc, member, others, activeIndex, prospectiveIndex };
  });
  const [accepted, blocked] = await Promise.all([
    friendshipRepository.acceptedUnblockedPairKeys(pairs), friendOutingRepository.blockedRosterIndexes(rosters),
  ]);
  const access = new Map<string, OutingAccess>();
  for (const { doc, member, others, activeIndex, prospectiveIndex } of candidates) {
    if (!member) continue;
    const restricted = blocked.has(activeIndex) || others.some(id => !accepted.has(pairKeyOf(doc.creatorId, id)));
    if (member.status === 'accepted') access.set(String(doc._id), restricted ? 'restricted' : 'full');
    else if (!restricted && !blocked.has(prospectiveIndex) && accepted.has(pairKeyOf(doc.creatorId, userId))) {
      access.set(String(doc._id), member.status === 'pending' ? 'invited' : 'declined');
    }
  }
  return access;
}
function common(doc: OutingHeader, userId: string, access: OutingAccess) {
  return {
    id: doc._id.toString(), access, title: access === 'restricted' ? 'Buổi chia tiền' : doc.title,
    outingDate: doc.outingDate, creatorId: doc.creatorId,
    myMembership: doc.participants.find((p) => p.userId === userId)!.status,
    revision: doc.revision, financeRevision: doc.financeRevision, phase: doc.phase,
    createdAt: doc.createdAt.toISOString(),
  };
}
export function outingSummary(doc: OutingHeader, userId: string, access: OutingAccess) {
  const base = common(doc, userId, access);
  if (access === 'invited' || access === 'declined') return base;
  return { ...base, memberCount: doc.participants.filter((p) => p.status === 'accepted').length, totalExpenses: doc.totalExpenses };
}
export function outingCapacity(doc: FriendOutingRecord) {
  return {
    participants: { used: doc.participants.length, max: OUTING_LIMITS.participants },
    expenses: { used: doc.expenses.length, max: OUTING_LIMITS.expenses },
    settlements: { used: doc.settlements.length, max: OUTING_LIMITS.settlements },
    edits: { used: doc.editCount, max: OUTING_LIMITS.edits },
    ordinaryOperations: { used: doc.ordinaryOperations, max: OUTING_LIMITS.ordinaryOperations },
    reservedOperations: { used: doc.reservedOperations, max: OUTING_LIMITS.reservedOperations },
    editsFrozen: !!doc.ordinaryWritesClosed || doc.ordinaryOperations >= OUTING_LIMITS.ordinaryOperations,
    finalSettlementSlots: doc.settlements.length >= OUTING_LIMITS.settlements - OUTING_LIMITS.finalSettlementSlots,
  };
}
export async function outingView(doc: FriendOutingRecord, me: UserDoc) {
  // Recheck current ACL after commit/replay. Do not cache social DTOs in receipts.
  const userId = me._id.toString(), access = await outingAccess(doc, userId), base = common(doc, userId, access);
  if (access === 'invited' || access === 'declined') return base;
  const balances = outingBalances(doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId), doc.expenses, doc.settlements);
  let eventId: string | null = null;
  if (access === 'full' && doc.eventId) {
    try { await friendEventService.visibleEvent(me, doc.eventId); eventId = doc.eventId.toString(); }
    catch (err) { if (!(err && typeof err === 'object' && 'status' in err && err.status === 404)) throw err; }
  }
  return {
    ...base, eventId,
    participants: doc.participants.map((p): OutingParticipant => ({ userId: p.userId, displayName: p.displayName, status: p.status, consent: p.consent ? { ...p.consent } : null })),
    expenses: doc.expenses.map((e) => ({ ...e, title: access === 'restricted' ? null : e.title, allocations: e.allocations.map((a) => ({ ...a })), createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() })),
    settlements: doc.settlements.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), resolvedAt: s.resolvedAt?.toISOString() ?? null })),
    balances, suggestions: suggestTransfers(balances), totalExpenses: doc.totalExpenses, capacity: outingCapacity(doc),
  };
}
export type FriendOutingView = Awaited<ReturnType<typeof outingView>>;
export type FriendOutingSummary = ReturnType<typeof outingSummary>;
