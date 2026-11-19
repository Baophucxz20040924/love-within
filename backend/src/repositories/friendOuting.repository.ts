import { Types, mongo } from 'mongoose';
import { FriendOuting, OUTING_LIMITS, type FriendOutingRecord } from '../models/FriendOuting.js';
import { FriendBlock } from '../models/FriendSafety.js';
import { AppError } from '../utils/errors.js';

export type OutingHeader = Pick<FriendOutingRecord, '_id' | 'creatorId' | 'eventId' | 'title' | 'outingDate' | 'participants' | 'phase' | 'revision' | 'financeRevision' | 'totalExpenses' | 'createdAt'>;
const headerProjection = '_id creatorId eventId title outingDate participants phase revision financeRevision totalExpenses createdAt';
const writeConcern = { w: 1, j: true } as const;
export const outingCapacityError = () => new AppError(409, 'OUTING_CAPACITY', 'Sổ đã đạt giới hạn. Giữ nguyên lịch sử; cần nâng phiên bản để mở thêm dung lượng');
export function outingBsonBytes(record: FriendOutingRecord): number {
  return mongo.BSON.calculateObjectSize(record);
}
export function assertOutingCapacity(record: FriendOutingRecord, ordinary: boolean): void {
  if (record.participants.length > OUTING_LIMITS.participants || record.expenses.length > OUTING_LIMITS.expenses ||
      record.settlements.length > OUTING_LIMITS.settlements || record.editCount > OUTING_LIMITS.edits ||
      record.ordinaryOperations > OUTING_LIMITS.ordinaryOperations || record.reservedOperations > OUTING_LIMITS.reservedOperations ||
      record.receipts.length > OUTING_LIMITS.ordinaryOperations + OUTING_LIMITS.reservedOperations ||
      outingBsonBytes(record) >= (ordinary ? OUTING_LIMITS.ordinaryBytes : OUTING_LIMITS.maximumBytes)) throw outingCapacityError();
}
/** No ledger query ever joins to live event RSVP or updates separate balance rows. */
export const friendOutingRepository = {
  find(id: string): Promise<FriendOutingRecord | null> { return FriendOuting.findOne({ _id: id, deletedAt: null }).lean<FriendOutingRecord>().exec(); },
  findRaw(id: string): Promise<FriendOutingRecord | null> { return FriendOuting.findById(id).lean<FriendOutingRecord>().exec(); },
  findCreate(creatorId: string, createOperationId: string): Promise<FriendOutingRecord | null> {
    return FriendOuting.findOne({ creatorId, createOperationId }).lean<FriendOutingRecord>().exec();
  },
  async create(record: FriendOutingRecord): Promise<FriendOutingRecord> {
    const doc = new FriendOuting(record);
    await doc.save(writeConcern);
    return doc.toObject() as FriendOutingRecord;
  },
  async compareAndSwap(beforeRevision: number, record: FriendOutingRecord): Promise<boolean> {
    // Full replacement deliberately preserves every receipt and all audit metadata; no truncation/TTL.
    const result = await FriendOuting.replaceOne({ _id: record._id, revision: beforeRevision, deletedAt: null }, record, { writeConcern, runValidators: true }).exec();
    return result.matchedCount === 1;
  },
  list(userId: string, limit: number, before?: string, eventId?: string): Promise<OutingHeader[]> {
    return FriendOuting.find({ deletedAt: null, 'participants.userId': userId,
      ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {}),
      ...(eventId ? { eventId: new Types.ObjectId(eventId) } : {}),
    }).select(headerProjection).sort({ _id: -1 }).limit(limit).lean<OutingHeader[]>().exec();
  },
  headers(userId: string, ids: string[]): Promise<OutingHeader[]> {
    return FriendOuting.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, deletedAt: null, 'participants.userId': userId })
      .select(headerProjection).lean<OutingHeader[]>().exec();
  },
  /** Relationship changes can revoke pending invitations or restrict historical ledgers. */
  affectedByRelationship(a: string, b: string): Promise<OutingHeader[]> {
    return FriendOuting.find({ deletedAt: null, 'participants.userId': { $all: [a, b] } })
      .select(headerProjection).lean<OutingHeader[]>().exec();
  },
  /** Exact roster clauses avoid treating a block across unrelated outings as a shared restriction. */
  async blockedRosterIndexes(rosters: readonly (readonly string[])[]): Promise<Set<number>> {
    const blocked = new Set<number>();
    const chunkSize = 25;
    for (let offset = 0; offset < rosters.length; offset += chunkSize) {
      const chunk = rosters.slice(offset, offset + chunkSize).map(ids => new Set(ids));
      const clauses = chunk.filter(ids => ids.size > 1).map(ids => {
        const objectIds = [...ids].map(id => new Types.ObjectId(id));
        return { blockerId: { $in: objectIds }, blockedId: { $in: objectIds } };
      });
      if (!clauses.length) continue;
      const edges = await FriendBlock.find({ $or: clauses }).select('-_id blockerId blockedId').lean().exec();
      chunk.forEach((ids, index) => {
        if (edges.some(edge => ids.has(String(edge.blockerId)) && ids.has(String(edge.blockedId)))) blocked.add(offset + index);
      });
    }
    return blocked;
  },
  /** Bounded to the <=50 members, unlike loading every user's entire block history. */
  async groupHasBlock(ids: string[]): Promise<boolean> {
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    return !!await FriendBlock.exists({ blockerId: { $in: objectIds }, blockedId: { $in: objectIds } }).exec();
  },
};
