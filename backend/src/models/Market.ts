import { Schema, model, type Document, type Types } from 'mongoose';

export type MarketItemStatus = 'available' | 'archived';

/**
 * A reward one member OFFERS to the other ("Massage 15 phút"). `createdBy` is the owner of
 * the shop: only they can edit/archive it, and only their partner can redeem it.
 */
export interface MarketItemDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  title: string;
  description: string;
  emoji: string;
  priceCoin: number;
  createdBy: Types.ObjectId;
  status: MarketItemStatus;
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<MarketItemDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    emoji: { type: String, default: '🎁', maxlength: 8 },
    priceCoin: { type: Number, required: true, min: 1, max: 1_000_000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['available', 'archived'], default: 'available' },
  },
  { timestamps: true },
);

itemSchema.index({ coupleId: 1, status: 1, createdAt: -1 });

export const MarketItem = model<MarketItemDoc>('MarketItem', itemSchema);

/**
 * requested → (seller) accepted → (buyer) fulfilled
 *           → (seller) declined   — coins refunded
 *           → (buyer)  cancelled  — coins refunded
 */
export type RedemptionStatus = 'reserving' | 'requested' | 'accepted' | 'fulfilled' | 'refunding' | 'declined' | 'cancelled' | 'rejected';
export const OPEN_REDEMPTION_STATUSES = ['reserving', 'requested', 'accepted', 'refunding'];

export interface MarketRedemptionDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  itemId: Types.ObjectId;
  itemTitle: string; // snapshots so history survives edits/archival
  itemEmoji: string;
  buyerUserId: Types.ObjectId;
  sellerUserId: Types.ObjectId;
  priceCoin: number;
  status: RedemptionStatus;
  requestKey?: string;
  refundIntent: { target: 'declined' | 'cancelled'; actorUserId: string } | null;
  responseNote: string | null; // optional message from the seller when declining
  respondedAt: Date | null;
  fulfilledAt: Date | null;
  createdAt: Date;
}

const redemptionSchema = new Schema<MarketRedemptionDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'MarketItem', required: true },
    itemTitle: { type: String, required: true },
    itemEmoji: { type: String, default: '🎁' },
    buyerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    priceCoin: { type: Number, required: true },
    status: {
      type: String,
      enum: ['reserving', 'requested', 'accepted', 'fulfilled', 'refunding', 'declined', 'cancelled', 'rejected'],
      required: true,
    },
    requestKey: { type: String, immutable: true },
    refundIntent: { type: Schema.Types.Mixed, default: null },
    responseNote: { type: String, default: null, maxlength: 200 },
    respondedAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

redemptionSchema.index({ coupleId: 1, buyerUserId: 1, requestKey: 1 }, { unique: true, name: 'market_request_key', partialFilterExpression: { requestKey: { $type: 'string' } } });
redemptionSchema.index({ coupleId: 1, itemId: 1, buyerUserId: 1 }, { unique: true, name: 'market_one_open', partialFilterExpression: { status: { $in: OPEN_REDEMPTION_STATUSES } } });
redemptionSchema.index({ coupleId: 1, createdAt: -1 });
redemptionSchema.index({ coupleId: 1, status: 1, createdAt: -1 });

export const MarketRedemption = model<MarketRedemptionDoc>('MarketRedemption', redemptionSchema);
