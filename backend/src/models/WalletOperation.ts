import { Schema, model, type Document, type Types } from 'mongoose';
import type { LedgerReason } from './LedgerEntry.js';

export interface RewardProvenance {
  version: 1;
  source: 'checkin' | 'moment' | 'quest';
  localDate: string;
  policyVersion: 2;
  component: 'checkin_pair' | 'checkin_exp' | 'photo_base' | 'timely_pair_bonus' | 'quest_exp';
  /** Per beneficiary, not a guessed total derived from ledger delta. */
  baseCoin: number;
  bonusCoin: number;
  commonStreak?: number;
}
export interface OperationPayload {
  actorUserId: string;
  allocations: Record<string, number>;
  exp: number;
  reason: LedgerReason;
  refId: string | null;
  /** Absent on v1 payloads: never add defaults to their fingerprint. */
  provenance?: RewardProvenance;
}
export interface OperationResult {
  balances: Record<string, number>;
  exp?: number;
  level?: number;
  leveledUp?: boolean;
}
export interface WalletOperationDoc extends Document<string> {
  _id: string;
  coupleId: Types.ObjectId;
  payload: OperationPayload;
  fingerprint: string;
  status: 'pending' | 'committed' | 'rejected';
  result: OperationResult | null;
  createdAt: Date;
}

// Permanent tombstones: a business key must never become reusable after journal compaction.
const schema = new Schema<WalletOperationDoc>({
  _id: { type: String, required: true },
  coupleId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  payload: { type: Schema.Types.Mixed, required: true, immutable: true },
  fingerprint: { type: String, required: true, immutable: true },
  status: { type: String, enum: ['pending', 'committed', 'rejected'], default: 'pending' },
  result: { type: Schema.Types.Mixed, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ coupleId: 1, status: 1 });
export const WalletOperation = model<WalletOperationDoc>('WalletOperation', schema);

/** Stored atomically with the source claim; absent on historical paid/ambiguous claims. */
export interface RewardIntent {
  operationId: string;
  actorUserId: string;
  coin: number;
  exp: number;
  ownerUserId: string | null;
  localDate?: string;
  /** New intents freeze allocations rather than re-reading mutable membership. */
  allocations?: Record<string, number>;
  provenance?: RewardProvenance;
}
