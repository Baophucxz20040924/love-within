import type { Types } from 'mongoose';
import {
  MarketItem,
  MarketRedemption,
  OPEN_REDEMPTION_STATUSES,
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

  async assertReservationIndexes(): Promise<void> {
    const indexes = await MarketRedemption.collection.indexes();
    const open = indexes.find((i) => i.name === 'market_one_open');
    const key = indexes.find((i) => i.name === 'market_request_key');
    const statuses = open?.partialFilterExpression?.status?.$in;
    if (!open?.unique || JSON.stringify(open.key) !== JSON.stringify({ coupleId: 1, itemId: 1, buyerUserId: 1 })
      || !Array.isArray(statuses) || [...statuses].sort().join(',') !== [...OPEN_REDEMPTION_STATUSES].sort().join(',')
      || !key?.unique || JSON.stringify(key.key) !== JSON.stringify({ coupleId: 1, buyerUserId: 1, requestKey: 1 })
      || key.partialFilterExpression?.requestKey?.$type !== 'string') {
      throw new Error('Market reservation indexes missing; complete the personal-wallet cutover before enabling writes');
    }
  },

  createRedemption(input: {
    _id: Types.ObjectId;
    requestKey: string;
    coupleId: Types.ObjectId;
    itemId: Types.ObjectId;
    itemTitle: string;
    itemEmoji: string;
    buyerUserId: Types.ObjectId;
    sellerUserId: Types.ObjectId;
    priceCoin: number;
  }): Promise<MarketRedemptionDoc> {
    return MarketRedemption.create({ ...input, status: 'reserving' });
  },

  findRequest(coupleId: Types.ObjectId, buyerUserId: Types.ObjectId, requestKey: string) {
    return MarketRedemption.findOne({ coupleId, buyerUserId, requestKey }).exec();
  },

  findRedemption(coupleId: Types.ObjectId, id: string): Promise<MarketRedemptionDoc | null> {
    return MarketRedemption.findOne({ _id: id, coupleId }).exec();
  },

  /** An open request by this buyer for this item (guards against double taps). */
  findOpenRequest(coupleId: Types.ObjectId, itemId: Types.ObjectId, buyerUserId: Types.ObjectId): Promise<MarketRedemptionDoc | null> {
    return MarketRedemption.findOne({ coupleId, itemId, buyerUserId, status: { $in: OPEN_REDEMPTION_STATUSES } }).exec();
  },

  listUnsettled(coupleId: Types.ObjectId): Promise<MarketRedemptionDoc[]> {
    return MarketRedemption.find({ coupleId, status: { $in: ['reserving', 'refunding'] } }).sort({ createdAt: 1 }).limit(20).exec();
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
    patch: Partial<Pick<MarketRedemptionDoc, 'responseNote' | 'respondedAt' | 'fulfilledAt' | 'refundIntent'>> = {},
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
