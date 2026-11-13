import { Schema, model, type Document, type Types } from 'mongoose';

export interface SavingsEntryDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  goalId: Types.ObjectId;
  userId: Types.ObjectId;
  amountVnd: number;
  occurredOn: string;
  note: string;
  source: 'manual' | 'bank';
  bankTxnId: Types.ObjectId | null;
  bankFingerprint: string | null;
  /** Owner/couple-scoped opaque idempotency key; never returned to clients. */
  operationKeyHash: string | null;
  operationPayloadHash: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<SavingsEntryDoc>({
  coupleId: { type: Schema.Types.ObjectId, required: true, ref: 'Couple' },
  goalId: { type: Schema.Types.ObjectId, required: true, ref: 'SavingsGoal' },
  userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  amountVnd: { type: Number, required: true, min: -10_000_000_000, max: 10_000_000_000,
    validate: (v: number) => Number.isSafeInteger(v) && v !== 0 },
  occurredOn: { type: String, required: true },
  note: { type: String, default: '', maxlength: 200 },
  source: { type: String, enum: ['manual', 'bank'], required: true },
  bankTxnId: { type: Schema.Types.ObjectId, default: null },
  bankFingerprint: { type: String, default: null },
  operationKeyHash: { type: String, default: null },
  operationPayloadHash: { type: String, default: null },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ coupleId: 1, goalId: 1, deletedAt: 1, occurredOn: -1, _id: -1 });
// Soft deletion deliberately does not release either deduplication key.
schema.index({ operationKeyHash: 1 }, { unique: true, partialFilterExpression: { operationKeyHash: { $type: 'string' } } });
schema.index({ bankTxnId: 1 }, { unique: true, partialFilterExpression: { bankTxnId: { $type: 'objectId' } } });
schema.index({ bankFingerprint: 1 }, { unique: true, partialFilterExpression: { bankFingerprint: { $type: 'string' } } });
export const SavingsEntry = model<SavingsEntryDoc>('SavingsEntry', schema);
