import { Schema, model, type Document, type Types } from 'mongoose';

export const TXN_DIRECTIONS = ['in', 'out'] as const;
export type TxnDirection = (typeof TXN_DIRECTIONS)[number];

export const MAX_TXN_NOTE = 200;

/**
 * One bank transaction of one user. Scoped by userId (personal money, not couple data);
 * the partner's read access is decided at read time by the owner's financeVisibility.
 * Deliberately NOT stored: transfer description, balance, full account number.
 */
export interface BankTransactionDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  connectionId: Types.ObjectId;
  /** Bank reference (MB "FT..." code). Dedupe key together with userId. */
  providerTxnId: string;
  direction: TxnDirection;
  /** VND, positive integer. */
  amount: number;
  occurredAt: Date;
  /** "YYYY-MM-DD" in the owner's timezone, for month filters. */
  localDate: string;
  /** Owner-only note. */
  note: string;
  noteUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const bankTransactionSchema = new Schema<BankTransactionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'BankConnection', required: true },
    providerTxnId: { type: String, required: true },
    direction: { type: String, enum: TXN_DIRECTIONS, required: true },
    amount: { type: Number, required: true, min: 1 },
    occurredAt: { type: Date, required: true },
    localDate: { type: String, required: true },
    note: { type: String, default: '', maxlength: MAX_TXN_NOTE },
    noteUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Dedupe across repeated polls and re-linking the same account.
bankTransactionSchema.index({ userId: 1, providerTxnId: 1 }, { unique: true });
// List newest first with a cursor.
bankTransactionSchema.index({ userId: 1, occurredAt: -1, _id: -1 });
// Monthly totals.
bankTransactionSchema.index({ userId: 1, localDate: 1 });

export const BankTransaction = model<BankTransactionDoc>('BankTransaction', bankTransactionSchema);
