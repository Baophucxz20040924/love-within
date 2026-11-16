import { Types } from 'mongoose';
import type { UserDoc } from '../models/User.js';
import { OUTING_LIMITS, type FriendOutingRecord, type OutingParticipant, type OutingReceipt } from '../models/FriendOuting.js';
import { assertOutingCapacity, friendOutingRepository, outingBsonBytes } from '../repositories/friendOuting.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { friendshipRepository } from '../repositories/friendship.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { friendEventService } from './friendEvent.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import { realtimeService } from './realtime.service.js';
import { invalidateSuggestionCache } from './friendSuggestion.service.js';

const invalidateOuting = (doc: FriendOutingRecord) => realtimeAudience.outing(doc, ['friend-outings']).catch(() => {});
import { profileService } from './profile.service.js';
import { outingAccess, outingInvitationEligible, outingRestricted, outingSummary, outingView } from './friendOuting.views.js';
import { applyOutingMutation, outingOperationConflict, outingRevisionConflict, outingRestrictedError } from './friendOuting.mutations.js';
import { outingPayloadHash, type OutingCreateInput, type OutingMutationInput, type OutingMutationKind } from './friendOuting.validation.js';
export type { FriendOutingView, FriendOutingSummary } from './friendOuting.views.js';

export interface OutingNotificationEvent {
  type: 'outing_invite' | 'outing_added' | 'outing_changed' | 'outing_review' | 'outing_closed' | 'outing_settlement' | 'outing_completed';
  outingId: string; actorId: string; recipientIds: string[]; operationId: string;
}
let notificationHook: ((event: OutingNotificationEvent) => Promise<void>) | undefined;
/** Main app installs the friends notification adapter. No ledger amounts or text are sent to push. */
export function configureFriendOutingNotifications(handler: (event: OutingNotificationEvent) => Promise<void>): void { notificationHook = handler; }
async function notify(event: OutingNotificationEvent): Promise<void> {
  if (!event.recipientIds.length) return;
  if (!notificationHook) { logger.warn('Outing notification adapter not configured', { outingId: event.outingId, type: event.type }); return; }
  try { await notificationHook(event); }
  catch { logger.warn('Outing notification delivery failed after commit', { outingId: event.outingId, type: event.type }); }
}
const duplicate = (err: unknown) => !!err && typeof err === 'object' && 'code' in err && err.code === 11000;
const outcomeUnknown = () => new AppError(503, 'OUTING_OUTCOME_UNKNOWN', 'Chưa xác định được kết quả ghi sổ. Giữ nguyên mã thao tác và nội dung để thử lại');
async function required(id: string, me: UserDoc): Promise<FriendOutingRecord> {
  const doc = await friendOutingRepository.find(id);
  if (!doc) throw Errors.notFound('Buổi chia tiền không tồn tại');
  await outingAccess(doc, me._id.toString());
  return doc;
}
function receiptFor(doc: FriendOutingRecord, actorId: string, operationId: string, kind: string, hash: string): OutingReceipt | undefined {
  const receipt = doc.receipts.find((r) => r.operationId === operationId);
  if (receipt && (receipt.actorId !== actorId || receipt.kind !== kind || receipt.hash !== hash)) throw outingOperationConflict();
  return receipt;
}
async function result(doc: FriendOutingRecord, me: UserDoc, receipt: OutingReceipt, replayed: boolean) {
  return { outing: await outingView(doc, me), outcome: { operationId: receipt.operationId, kind: receipt.kind, resultId: receipt.resultId, committedRevision: receipt.revision, replayed } };
}
/** Legacy invite endpoint: new people join directly; existing pending/declined rows are never reactivated.
 * Checks current creator friendship AND blocks independently, including blocks between new members. Not a cross-collection transaction. */
async function invitedParticipants(creatorId: string, ids: string[], current: OutingParticipant[]): Promise<OutingParticipant[]> {
  if (ids.some((id) => id === creatorId || current.some((p) => p.userId === id))) throw Errors.badRequest('Thành viên đã có trong sổ');
  const rows = await friendshipRepository.listBetween(creatorId, ids);
  if (rows.filter((r) => r.status === 'accepted').length !== ids.length) throw Errors.badRequest('Chỉ mời được bạn bè hiện tại');
  const activeIds = [...current.filter((p) => p.status === 'accepted').map((p) => p.userId), ...ids];
  if (await friendOutingRepository.groupHasBlock(activeIds)) throw outingRestrictedError();
  const profiles = await profileService.load(ids.map((id) => new Types.ObjectId(id)));
  return ids.map((userId) => ({ userId, displayName: (profiles.get(userId)?.displayName || 'Người dùng').slice(0, 100), status: 'accepted', consent: null }));
}
function notificationFor(doc: FriendOutingRecord, actorId: string, kind: OutingMutationKind, input: OutingMutationInput, resultId: string): OutingNotificationEvent {
  let type: OutingNotificationEvent['type'] = 'outing_changed';
  let recipients = doc.participants.filter((p) => p.status === 'accepted').map((p) => p.userId);
  if (kind === 'invite') { type = 'outing_added'; recipients = input.userIds!; }
  else if (kind === 'close_review' || kind === 'object') type = 'outing_review';
  else if (kind === 'approve' && doc.phase === 'settling') type = 'outing_closed';
  else if (kind.startsWith('settlement_')) {
    type = 'outing_settlement'; const s = doc.settlements.find((s) => s.id === resultId)!; recipients = [s.fromUserId, s.toUserId];
  } else if (kind === 'complete') type = 'outing_completed';
  return { type, outingId: doc._id.toString(), actorId, recipientIds: recipients.filter((id) => id !== actorId), operationId: input.operationId };
}
function decodeCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^v1:[a-f0-9]{24}$/.test(decoded) || Buffer.from(decoded).toString('base64url') !== cursor) throw Errors.badRequest('Cursor không hợp lệ');
  return decoded.slice(3);
}
/** Capture viewers while the relationship still grants access; never expose relationship details in hints. */
export async function captureRelationshipAudience(a: string, b: string): Promise<string[]> {
  const recipients = new Set<string>([a, b]);
  try {
    const [af, bf, ab, bb] = await Promise.all([
      friendshipRepository.friendIds(a), friendshipRepository.friendIds(b),
      friendBlockRepository.blockedIdsFor(new Types.ObjectId(a)), friendBlockRepository.blockedIdsFor(new Types.ObjectId(b)),
    ]);
    for (const id of af) if (!ab.has(id.toString())) recipients.add(id.toString());
    for (const id of bf) if (!bb.has(id.toString())) recipients.add(id.toString());
  } catch { /* Hints must never prevent the relationship write. */ }
  try {
    for (const doc of await friendOutingRepository.affectedByRelationship(a, b)) {
      for (const p of doc.participants) {
        if (p.status === 'accepted' || await outingInvitationEligible(doc, p.userId).catch(() => false)) recipients.add(p.userId);
      }
    }
  } catch { /* Preserve already captured recipients. */ }
  return [...recipients];
}
export function invalidateRelationshipAudience(ids: string[], access = false): void {
  invalidateSuggestionCache(ids);
  try { realtimeService.publish(ids, 'friends', ['friends'], access); } catch { /* committed writes remain successful */ }
}

export const friendOutingService = {
  async create(me: UserDoc, input: OutingCreateInput) {
    const actorId = me._id.toString(), hash = outingPayloadHash('create', input);
    const previous = await friendOutingRepository.findCreate(actorId, input.operationId);
    if (previous) {
      if (previous.createHash !== hash) throw outingOperationConflict();
      return result(previous, me, previous.receipts[0], true);
    }
    if (input.eventId) {
      const ev = await friendEventService.visibleEvent(me, input.eventId);
      if (!ev.creatorId.equals(me._id)) throw Errors.forbidden('Chỉ chủ kèo được tạo sổ từ kèo');
      if (input.inviteeIds.some((id) => !ev.inviteeIds.some((i) => i.toString() === id))) throw Errors.badRequest('Hãy chọn thành viên trong kèo');
    }
    const creator: OutingParticipant = { userId: actorId, displayName: me.displayName.slice(0, 100) || 'Người dùng', status: 'accepted', consent: null };
    const invited = await invitedParticipants(actorId, input.inviteeIds, [creator]);
    const now = new Date(), id = new Types.ObjectId();
    const receipt: OutingReceipt = { actorId, operationId: input.operationId, kind: 'create', hash, resultId: id.toString(), revision: 1, financeRevision: 1, at: now, bucket: 'ordinary' };
    const doc: FriendOutingRecord = {
      _id: id, schemaVersion: 1, creatorId: actorId, createOperationId: input.operationId, createHash: hash,
      eventId: input.eventId ? new Types.ObjectId(input.eventId) : null, title: input.title, outingDate: input.outingDate,
      participants: [creator, ...invited], expenses: [], settlements: [], receipts: [receipt], phase: 'collecting',
      revision: 1, financeRevision: 1, ordinaryOperations: 1, reservedOperations: 0, editCount: 0, totalExpenses: 0,
      frozenAt: null, completedAt: null, createdAt: now, updatedAt: now,
    };
    assertOutingCapacity(doc, true);
    try { await friendOutingRepository.create(doc); }
    catch (err) {
      // Includes ambiguous acknowledgements: read back before reporting an error; clients must keep the same key.
      const saved = await friendOutingRepository.findCreate(actorId, input.operationId).catch(() => { throw outcomeUnknown(); });
      if (saved) {
        if (saved.createHash !== hash) throw outingOperationConflict();
        await invalidateOuting(saved);
        return result(saved, me, saved.receipts[0], true);
      }
      if (duplicate(err)) throw new AppError(409, 'OUTING_EVENT_EXISTS', 'Kèo này đã có sổ chia tiền');
      throw outcomeUnknown();
    }
    await invalidateOuting(doc);
    await notify({ type: 'outing_added', outingId: id.toString(), actorId, recipientIds: input.inviteeIds, operationId: input.operationId });
    return result(doc, me, receipt, false);
  },
  async get(me: UserDoc, id: string) { return outingView(await required(id, me), me); },
  async list(me: UserDoc, input: { limit: number; cursor?: string; eventId?: string }) {
    const actorId = me._id.toString();
    // Bound work to one projected page. An empty page can still have a nextCursor when invitations lost social access.
    const rows = await friendOutingRepository.list(actorId, input.limit + 1, decodeCursor(input.cursor), input.eventId);
    const page = rows.slice(0, input.limit), items = [];
    for (const row of page) {
      try { items.push(outingSummary(row, actorId, await outingAccess(row, actorId))); }
      catch (err) { if (!(err instanceof AppError && err.status === 404)) throw err; }
    }
    return { items, nextCursor: rows.length > input.limit ? Buffer.from(`v1:${page[page.length - 1]._id.toString()}`).toString('base64url') : null };
  },
  async mutate(me: UserDoc, id: string, kind: OutingMutationKind, input: OutingMutationInput, targetId?: string) {
    const actorId = me._id.toString(), hash = outingPayloadHash(kind, input, targetId), doc = await required(id, me);
    const replay = receiptFor(doc, actorId, input.operationId, kind, hash);
    if (replay) return result(doc, me, replay, true);
    if (doc.revision !== input.expectedRevision) throw outingRevisionConflict();
    const beforeRevision = doc.revision;
    const restricted = await outingRestricted(doc);
    let invited: OutingParticipant[] = [];
    if (kind === 'invite') {
      if (actorId !== doc.creatorId) throw Errors.forbidden('Chỉ người tạo được mời thêm');
      if (doc.phase !== 'collecting' && doc.phase !== 'review') throw new AppError(409, 'OUTING_PHASE', 'Sổ đã chốt, không thể thêm thành viên');
      if (restricted) throw outingRestrictedError();
      invited = await invitedParticipants(actorId, input.userIds!, doc.participants);
    }
    // Accepted-only restriction deliberately excludes pending actors. Recheck their
    // prospective membership separately instead of trusting the earlier read ACL.
    if (kind === 'accept' && !(await outingInvitationEligible(doc, actorId))) throw outingRestrictedError();
    const applied = applyOutingMutation(doc, actorId, kind, input, restricted, targetId, invited);
    doc.revision++; doc.updatedAt = new Date();
    const receipt: OutingReceipt = { operationId: input.operationId, actorId, kind, hash, resultId: applied.resultId,
      revision: doc.revision, financeRevision: doc.financeRevision, at: doc.updatedAt, bucket: applied.bucket };
    doc.receipts.push(receipt);
    // At the ordinary byte boundary, final signatures/review must still have a path forward.
    // Permanently close ordinary writes in the SAME CAS, so objections/edits cannot churn this reserve.
    if ((kind === 'approve' || kind === 'close_review') &&
        (receipt.bucket === 'reserved' || outingBsonBytes(doc) >= OUTING_LIMITS.ordinaryBytes)) {
      if (receipt.bucket === 'ordinary') {
        doc.ordinaryOperations--; doc.reservedOperations++; receipt.bucket = 'reserved';
      }
      doc.ordinaryWritesClosed = true;
    }
    assertOutingCapacity(doc, receipt.bucket === 'ordinary');
    let committed: boolean;
    try { committed = await friendOutingRepository.compareAndSwap(beforeRevision, doc); }
    catch {
      const fresh = await required(id, me).catch((err: unknown) => {
        if (err instanceof AppError && (err.status === 403 || err.status === 404)) throw err;
        throw outcomeUnknown();
      });
      const confirmed = receiptFor(fresh, actorId, input.operationId, kind, hash);
      if (confirmed) {
        await invalidateOuting(fresh);
        return result(fresh, me, confirmed, true);
      }
      throw outcomeUnknown();
    }
    if (!committed) {
      const fresh = await required(id, me), confirmed = receiptFor(fresh, actorId, input.operationId, kind, hash);
      if (confirmed) return result(fresh, me, confirmed, true);
      throw outingRevisionConflict();
    }
    await invalidateOuting(doc);
    await notify(notificationFor(doc, actorId, kind, input, applied.resultId));
    return result(doc, me, receipt, false);
  },
  async notificationVisibility(userId: string, ids: string[]): Promise<Map<string, { visible: boolean; restricted: boolean }>> {
    const result = new Map<string, { visible: boolean; restricted: boolean }>();
    const unique = [...new Set(ids)].filter((id) => /^[a-f\d]{24}$/i.test(id));
    for (let start = 0; start < unique.length; start += 100) {
      for (const doc of await friendOutingRepository.headers(userId, unique.slice(start, start + 100))) {
        try { const access = await outingAccess(doc, userId); result.set(doc._id.toString(), { visible: true, restricted: access === 'restricted' }); }
        catch (err) { if (!(err instanceof AppError && err.status === 404)) throw err; }
      }
    }
    return result;
  },
};
