import type { Types } from 'mongoose';
import {
  MarketItem,
  MarketRedemption,
  type MarketItemDoc,
  type MarketRedemptionDoc,
  type RedemptionStatus,
} from '../models/Market.js';

/** Every query is scoped by coupleId (Requirement 10.5 / 3.4). Item writes also require the owner. */
export const marketRepository = {
  listAvailable(coupleId: Types.ObjectId): Promise<MarketItemDoc[]> {
    return MarketItem.find({ coupleId, status: 'available' }).sort({ createdAt: -1 }).exec();
  },

  findItem(coupleId: Types.ObjectId, id: string): Promise<MarketItemDoc | null> {
    return MarketItem.findOne({ _id: id, coupleId }).exec();
  },

  createItem(input: {
    coupleId: Types.ObjectId;
    title: string;
    description: string;
    emoji: string;
    priceCoin: number;
    createdBy: Types.ObjectId;
  }): Promise<MarketItemDoc> {
    return MarketItem.create(input);
  },

  /** Only the shop owner's item matches, so the partner can never edit it. */
  updateItem(
    coupleId: Types.ObjectId,
    id: string,
    ownerId: Types.ObjectId,
    patch: Partial<Pick<MarketItemDoc, 'title' | 'description' | 'emoji' | 'priceCoin'>>,
  ): Promise<MarketItemDoc | null> {
    return MarketItem.findOneAndUpdate(
      { _id: id, coupleId, createdBy: ownerId, status: 'available' },
      { $set: patch },
      { new: true },
    ).exec();
  },

  archiveItem(coupleId: Types.ObjectId, id: string, ownerId: Types.ObjectId): Promise<MarketItemDoc | null> {
    return MarketItem.findOneAndUpdate(
      { _id: id, coupleId, createdBy: ownerId, status: 'available' },
      { $set: { status: 'archived' } },
      { new: true },
    ).exec();
  },

  countItemsSince(coupleId: Types.ObjectId, notBy: Types.ObjectId, since: Date | null): Promise<number> {
    const filter: Record<string, unknown> = { coupleId, status: 'available', createdBy: { $ne: notBy } };
    if (since) filter.createdAt = { $gt: since };
    return MarketItem.countDocuments(filter).exec();
  },

  // ── Redemptions ─────────────────────────────────────────

  createRedemption(input: {
    coupleId: Types.ObjectId;
    itemId: Types.ObjectId;
    itemTitle: string;
    itemEmoji: string;
    buyerUserId: Types.ObjectId;
    sellerUserId: Types.ObjectId;
    priceCoin: number;
  }): Promise<MarketRedemptionDoc> {
    return MarketRedemption.create({ ...input, status: 'requested' });
  },

  findRedemption(coupleId: Types.ObjectId, id: string): Promise<MarketRedemptionDoc | null> {
    return MarketRedemption.findOne({ _id: id, coupleId }).exec();
  },

  /** An open request by this buyer for this item (guards against double taps). */
  findOpenRequest(coupleId: Types.ObjectId, itemId: Types.ObjectId, buyerUserId: Types.ObjectId): Promise<MarketRedemptionDoc | null> {
    return MarketRedemption.findOne({ coupleId, itemId, buyerUserId, status: 'requested' }).exec();
  },

  listRedemptions(coupleId: Types.ObjectId, limit = 100): Promise<MarketRedemptionDoc[]> {
    return MarketRedemption.find({ coupleId }).sort({ createdAt: -1 }).limit(limit).exec();
  },

  listByStatus(coupleId: Types.ObjectId, status: RedemptionStatus): Promise<MarketRedemptionDoc[]> {
    return MarketRedemption.find({ coupleId, status }).sort({ createdAt: -1 }).limit(100).exec();
  },

  /**
   * Atomically move `from` → `to`. Returns null when the redemption was no longer in `from`,
   * so a double tap (or both members acting at once) applies exactly once.
   */
  transition(
    coupleId: Types.ObjectId,
    id: Types.ObjectId,
    from: RedemptionStatus,
    to: RedemptionStatus,
    patch: Partial<Pick<MarketRedemptionDoc, 'responseNote' | 'respondedAt' | 'fulfilledAt'>> = {},
  ): Promise<MarketRedemptionDoc | null> {
    return MarketRedemption.findOneAndUpdate(
      { _id: id, coupleId, status: from },
      { $set: { status: to, ...patch } },
      { new: true },
    ).exec();
  },

  /** Requests of `buyerId` that the seller answered after `since` (accepted or declined). */
  countRespondedSince(coupleId: Types.ObjectId, buyerId: Types.ObjectId, since: Date | null): Promise<number> {
    const filter: Record<string, unknown> = { coupleId, buyerUserId: buyerId, status: { $in: ['accepted', 'declined'] } };
    if (since) filter.respondedAt = { $gt: since };
    return MarketRedemption.countDocuments(filter).exec();
  },
};
