import { Schema, model, type Document, type Types } from 'mongoose';
import type { EncryptedSecret } from '../utils/crypto.js';

export type BankConnectionStatus = 'active' | 'error' | 'revoked';

/**
 * A user's linked bank account (MVP: one per user, MBBank via thueapibank.vn).
 * Revoking keeps the document (and the user's transactions unless purged) but drops the token.
 */
export interface BankConnectionDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  provider: 'thueapibank';
  bankBrand: 'MBBANK';
  accountLast4: string;
  /** Encrypted thueapibank token. null once revoked. Never returned by the API or logged. */
  tokenEnc: EncryptedSecret | null;
  status: BankConnectionStatus;
  lastPolledAt: Date | null;
  lastSuccessAt: Date | null;
  /** Short error code (+ provider message), never contains the token. */
  lastError: string | null;
  consecutiveErrors: number;
  createdAt: Date;
  updatedAt: Date;
}

const encryptedSchema = new Schema<EncryptedSecret>(
  {
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    data: { type: String, required: true },
  },
  { _id: false },
);

const bankConnectionSchema = new Schema<BankConnectionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    provider: { type: String, enum: ['thueapibank'], required: true },
    bankBrand: { type: String, enum: ['MBBANK'], required: true },
    accountLast4: { type: String, required: true, match: /^\d{4}$/ },
    tokenEnc: { type: encryptedSchema, default: null },
    status: { type: String, enum: ['active', 'error', 'revoked'], required: true },
    lastPolledAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    consecutiveErrors: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Background poll picks up active connections.
bankConnectionSchema.index({ status: 1 });

export const BankConnection = model<BankConnectionDoc>('BankConnection', bankConnectionSchema);
