import { Schema, model, type Document, type Types } from 'mongoose';
import type { RewardProvenance } from './WalletOperation.js';

export type LedgerType = 'coin' | 'exp';
export const LEDGER_REASONS = ['checkin', 'quest', 'market_purchase', 'market_refund', 'bucket_list', 'admin', 'moment'] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

/** Immutable audit record for every coin/EXP change. Never updated or deleted. */
export interface LedgerEntryDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  type: LedgerType;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  refId: Types.ObjectId | null;
  actorUserId: Types.ObjectId;
  ownerUserId: Types.ObjectId | null;
  operationKey?: string;
  provenance?: RewardProvenance;
  createdAt: Date;
}

const ledgerSchema = new Schema<LedgerEntryDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    type: { type: String, enum: ['coin', 'exp'], required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, enum: LEDGER_REASONS, required: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    operationKey: { type: String, immutable: true },
    provenance: { type: Schema.Types.Mixed, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerSchema.index({ operationKey: 1 }, { unique: true, partialFilterExpression: { operationKey: { $type: 'string' } } });
ledgerSchema.index({ coupleId: 1, ownerUserId: 1, createdAt: -1 });
ledgerSchema.index({ coupleId: 1, createdAt: -1 });
ledgerSchema.index({ coupleId: 1, type: 1, createdAt: -1 });

export const LedgerEntry = model<LedgerEntryDoc>('LedgerEntry', ledgerSchema);
