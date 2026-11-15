import { Schema, model, type Document, type Types } from 'mongoose';

interface AttemptBudget {
  failures: number;
  blockedUntil: Date | null;
  leaseId: string | null;
  leaseUntil: Date | null;
}

export interface PrivacyLockDoc extends Document {
  userId: Types.ObjectId;
  coupleHash: string | null;
  friendsHash: string | null;
  couple: boolean;
  friends: boolean;
  revision: number;
  unlockBudget: AttemptBudget;
  reauthBudget: AttemptBudget;
}

const budgetSchema = new Schema<AttemptBudget>({
  failures: { type: Number, required: true, default: 0 },
  blockedUntil: { type: Date, default: null },
  leaseId: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
}, { _id: false });

const privacyLockSchema = new Schema<PrivacyLockDoc>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  coupleHash: { type: String, default: null, select: false },
  friendsHash: { type: String, default: null, select: false },
  couple: { type: Boolean, required: true, default: false },
  friends: { type: Boolean, required: true, default: false },
  revision: { type: Number, required: true, default: 0 },
  unlockBudget: { type: budgetSchema, required: true, default: () => ({}) , select: false },
  reauthBudget: { type: budgetSchema, required: true, default: () => ({}), select: false },
}, { timestamps: true });

export const PrivacyLock = model<PrivacyLockDoc>('PrivacyLock', privacyLockSchema);
