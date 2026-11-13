import { Schema, model, type Document, type Types } from 'mongoose';

/** One shared coin wallet per couple (Love Coin is spent together at the market). */
export interface WalletDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  coinBalance: number;
  updatedAt: Date;
}

const walletSchema = new Schema<WalletDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true, unique: true },
    coinBalance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const Wallet = model<WalletDoc>('Wallet', walletSchema);
