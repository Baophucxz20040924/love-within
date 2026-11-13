import { Schema, model, type Types } from 'mongoose';

export const OUTING_LIMITS = Object.freeze({
  participants: 50, expenses: 200, settlements: 500, edits: 1000,
  ordinaryOperations: 3000, reservedOperations: 1052,
  expenseAmount: 100_000_000, totalExpenses: 10_000_000_000,
  // Leave 1 MiB for ALL remaining financial terminal operations, not just one next write.
  ordinaryBytes: 6 * 1024 * 1024, maximumBytes: 7 * 1024 * 1024,
  finalSettlementSlots: 49,
});
export type OutingPhase = 'collecting' | 'review' | 'settling' | 'completed';
export type OutingMembership = 'pending' | 'accepted' | 'declined';
export interface OutingParticipant {
  userId: string;
  displayName: string;
  status: OutingMembership;
  consent: { status: 'approved' | 'objected'; financeRevision: number } | null;
}
export interface OutingAllocation { userId: string; amount: number }
export interface OutingExpense {
  id: string; payerId: string; title: string; amount: number;
  // Original selection includes zero shares; allocations alone cannot reconstruct a 2 VND / 3 split.
  participantIds?: string[];
  splitMode: 'equal' | 'custom'; allocations: OutingAllocation[];
  status: 'active' | 'void'; createdAt: Date; updatedAt: Date;
}
export interface OutingSettlement {
  id: string; fromUserId: string; toUserId: string; amount: number;
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelled';
  createdAt: Date; resolvedAt: Date | null;
}
export interface OutingReceipt {
  operationId: string; actorId: string; kind: string; hash: string; resultId: string;
  revision: number; financeRevision: number; at: Date; bucket: 'ordinary' | 'reserved';
}
/** One snapshot and one CAS. No cross-document money updates and no persistent mutex. */
export interface FriendOutingRecord {
  _id: Types.ObjectId;
  schemaVersion: number;
  creatorId: string; createOperationId: string; createHash: string;
  eventId: Types.ObjectId | null; title: string; outingDate: string;
  participants: OutingParticipant[]; expenses: OutingExpense[]; settlements: OutingSettlement[];
  receipts: OutingReceipt[];
  phase: OutingPhase; revision: number; financeRevision: number;
  ordinaryOperations: number; reservedOperations: number; editCount: number;
  ordinaryWritesClosed?: boolean;
  totalExpenses: number; frozenAt: Date | null; completedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}
const consent = new Schema({
  status: { type: String, enum: ['approved', 'objected'], required: true },
  financeRevision: { type: Number, required: true },
}, { _id: false });
const participant = new Schema({
  userId: { type: String, required: true }, displayName: { type: String, required: true, maxlength: 100 },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], required: true },
  consent: { type: consent, default: null },
}, { _id: false });
const allocation = new Schema({
  userId: { type: String, required: true }, amount: { type: Number, required: true, min: 1, max: OUTING_LIMITS.expenseAmount },
}, { _id: false });
const expense = new Schema({
  id: { type: String, required: true }, payerId: { type: String, required: true },
  title: { type: String, required: true, maxlength: 160 },
  amount: { type: Number, required: true, min: 1, max: OUTING_LIMITS.expenseAmount },
  participantIds: { type: [String], default: undefined },
  splitMode: { type: String, enum: ['equal', 'custom'], required: true },
  allocations: { type: [allocation], required: true }, status: { type: String, enum: ['active', 'void'], required: true },
  createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true },
}, { _id: false });
const settlement = new Schema({
  id: { type: String, required: true }, fromUserId: { type: String, required: true }, toUserId: { type: String, required: true },
  amount: { type: Number, required: true, min: 1, max: OUTING_LIMITS.totalExpenses },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected', 'cancelled'], required: true },
  createdAt: { type: Date, required: true }, resolvedAt: { type: Date, default: null },
}, { _id: false });
const receipt = new Schema({
  operationId: { type: String, required: true, maxlength: 80 }, actorId: { type: String, required: true },
  kind: { type: String, required: true, maxlength: 40 }, hash: { type: String, required: true, maxlength: 64 },
  resultId: { type: String, required: true, maxlength: 24 }, revision: { type: Number, required: true },
  financeRevision: { type: Number, required: true }, at: { type: Date, required: true },
  bucket: { type: String, enum: ['ordinary', 'reserved'], required: true },
}, { _id: false });
const schema = new Schema<FriendOutingRecord>({
  schemaVersion: { type: Number, default: 1 }, creatorId: { type: String, required: true },
  createOperationId: { type: String, required: true, maxlength: 80 }, createHash: { type: String, required: true },
  eventId: { type: Schema.Types.ObjectId, default: null }, title: { type: String, required: true, maxlength: 100 },
  outingDate: { type: String, required: true }, participants: { type: [participant], default: [] },
  expenses: { type: [expense], default: [] }, settlements: { type: [settlement], default: [] }, receipts: { type: [receipt], default: [] },
  phase: { type: String, enum: ['collecting', 'review', 'settling', 'completed'], default: 'collecting' },
  revision: { type: Number, default: 1 }, financeRevision: { type: Number, default: 1 },
  ordinaryOperations: { type: Number, default: 1 }, reservedOperations: { type: Number, default: 0 }, editCount: { type: Number, default: 0 },
  ordinaryWritesClosed: { type: Boolean, default: false },
  totalExpenses: { type: Number, default: 0 }, frozenAt: { type: Date, default: null }, completedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true },
}, { versionKey: false, strict: 'throw', writeConcern: { w: 1, j: true } });
schema.index({ creatorId: 1, createOperationId: 1 }, { unique: true });
schema.index({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'objectId' } } });
schema.index({ 'participants.userId': 1, _id: -1 });
export const FriendOuting = model<FriendOutingRecord>('FriendOuting', schema);
