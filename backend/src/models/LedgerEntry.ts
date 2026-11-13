import { Schema, model, type Document, type Types } from 'mongoose';

export type LedgerType = 'coin' | 'exp';
export const LEDGER_REASONS = ['checkin', 'quest', 'market_purchase', 'market_refund', 'bucket_list', 'admin'] as const;
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerSchema.index({ coupleId: 1, createdAt: -1 });
ledgerSchema.index({ coupleId: 1, type: 1, createdAt: -1 });

export const LedgerEntry = model<LedgerEntryDoc>('LedgerEntry', ledgerSchema);
