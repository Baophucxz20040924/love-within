import { Schema, model, type Document, type Types } from 'mongoose';

export interface WalletPending {
  operationId: string;
  revision: number;
  balances: Record<string, number>;
  rejected: boolean;
}

/** One atomic aggregate, two independently spendable balances. coinBalance is a frozen legacy snapshot. */
export interface WalletDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  coinBalance: number;
  version: number;
  memberIds: string[];
  balances: Record<string, number>;
  revision: number;
  pending: WalletPending | null;
  migration: { originalBalance: number; allocations: Record<string, number>; migratedAt: Date } | null;
  updatedAt: Date;
}

const walletSchema = new Schema<WalletDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true, unique: true },
    coinBalance: { type: Number, default: 0, min: 0 },
    // No default version: legacy documents must pass the CAS migration.
    version: { type: Number },
    memberIds: { type: [String], default: undefined },
    balances: { type: Schema.Types.Mixed },
    revision: { type: Number, default: 0 },
    pending: { type: Schema.Types.Mixed, default: null },
    migration: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const Wallet = model<WalletDoc>('Wallet', walletSchema);
