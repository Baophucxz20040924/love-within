import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import type { MarketItemDoc, MarketRedemptionDoc, RedemptionStatus } from '../models/Market.js';
import { marketRepository } from '../repositories/market.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { walletService } from './wallet.service.js';
import { notificationService } from './notification.service.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const numberVi = new Intl.NumberFormat('vi-VN');

export interface MarketItemView {
  id: string;
  title: string;
  description: string;
  emoji: string;
  priceCoin: number;
  createdBy: string;
  /** True when the caller owns this item (they offer it; only the partner can redeem it). */
  isMine: boolean;
  status: string;
  createdAt: string;
}

export interface RedemptionView {
  id: string;
  itemId: string;
  itemTitle: string;
  itemEmoji: string;
  priceCoin: number;
  buyerUserId: string;
  sellerUserId: string;
  buyerName: string;
  sellerName: string;
  isBuyer: boolean;
  status: RedemptionStatus;
  responseNote: string | null;
  createdAt: string;
  respondedAt: string | null;
  fulfilledAt: string | null;
}

export interface ItemInput {
  title: string;
  description?: string;
  emoji?: string;
  priceCoin: number;
}

type Names = Map<string, string>;

function memberNames(couple: CoupleDoc): Promise<Names> {
  return userRepository.findDisplayNames(couple.memberIds);
}

function itemView(i: MarketItemDoc, userId: string): MarketItemView {
  const createdBy = i.createdBy.toString();
  return {
    id: i._id.toString(),
    title: i.title,
    description: i.description,
    emoji: i.emoji,
    priceCoin: i.priceCoin,
    createdBy,
    isMine: createdBy === userId,
    status: i.status,
    createdAt: i.createdAt.toISOString(),
  };
}

function redemptionView(r: MarketRedemptionDoc, userId: string, names: Names): RedemptionView {
  const buyer = r.buyerUserId.toString();
  const seller = r.sellerUserId.toString();
  return {
    id: r._id.toString(),
    itemId: r.itemId.toString(),
    itemTitle: r.itemTitle,
    itemEmoji: r.itemEmoji,
    priceCoin: r.priceCoin,
    buyerUserId: buyer,
    sellerUserId: seller,
    buyerName: names.get(buyer) ?? 'Người ấy',
    sellerName: names.get(seller) ?? 'Người ấy',
    isBuyer: buyer === userId,
    status: r.status,
    responseNote: r.responseNote ?? null,
    createdAt: r.createdAt.toISOString(),
    respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
    fulfilledAt: r.fulfilledAt ? r.fulfilledAt.toISOString() : null,
  };
}

async function requireRedemption(couple: CoupleDoc, id: string): Promise<MarketRedemptionDoc> {
  const r = await marketRepository.findRedemption(couple._id, id);
  if (!r) throw Errors.notFound('Yêu cầu đổi quà không tồn tại');
  return r;
}

/** Return the held coins to the shared wallet (decline / cancel). */
async function refund(couple: CoupleDoc, actorUserId: string, r: MarketRedemptionDoc): Promise<number> {
  const { balance } = await walletService.applyCoin({
    coupleId: couple._id,
    actorUserId,
    delta: r.priceCoin,
    reason: 'market_refund',
    refId: r._id,
  });
  return balance;
}

/** The seller answered: tell the buyer (never the response note). */
function notifyAnswered(r: MarketRedemptionDoc, body: (name: string) => string): Promise<void> {
  return notificationService.emit({
    space: 'couple',
    to: r.buyerUserId,
    actorId: r.sellerUserId,
    type: 'redemption_answered',
    entityId: r._id,
    push: { body, url: '/market', tag: `redemption:${r._id.toString()}` },
  });
}

/**
 * Shop model: each member runs their own shop of rewards they will perform for the partner.
 * Owners edit/archive their own items; only the partner can redeem them.
 *
 * Redemption flow: request (coins held) → seller accepts or declines (declined = refund)
 * → buyer marks it fulfilled when the reward was actually delivered. Buyer may cancel while pending.
 */
export const marketService = {
  async list(coupleId: Types.ObjectId, userId: string): Promise<MarketItemView[]> {
    return (await marketRepository.listAvailable(coupleId)).map((i) => itemView(i, userId));
  },

  async create(coupleId: Types.ObjectId, userId: string, input: ItemInput): Promise<MarketItemView> {
    const doc = await marketRepository.createItem({
      coupleId,
      title: input.title,
      description: input.description ?? '',
      emoji: input.emoji ?? '🎁',
      priceCoin: input.priceCoin,
      createdBy: new Types.ObjectId(userId),
    });
    await realtimeAudience.couple(coupleId, ['market']);
    logger.info('Market item created', { coupleId: coupleId.toString(), userId, itemId: doc._id.toString() });
    return itemView(doc, userId);
  },

  /** Owner only. */
  async update(coupleId: Types.ObjectId, userId: string, id: string, patch: Partial<ItemInput>): Promise<MarketItemView> {
    const existing = await marketRepository.findItem(coupleId, id);
    if (!existing || existing.status !== 'available') throw Errors.notFound('Món hàng không tồn tại');
    if (existing.createdBy.toString() !== userId) throw Errors.forbidden('Chỉ người đăng mới sửa được món này');
    const doc = await marketRepository.updateItem(coupleId, id, new Types.ObjectId(userId), patch);
    if (!doc) throw Errors.notFound('Món hàng không tồn tại');
    await realtimeAudience.couple(coupleId, ['market']);
    logger.info('Market item updated', { coupleId: coupleId.toString(), userId, itemId: id });
    return itemView(doc, userId);
  },

  /** Owner only. Open requests for the item stay valid (they already hold their coins). */
  async archive(coupleId: Types.ObjectId, userId: string, id: string): Promise<void> {
    const existing = await marketRepository.findItem(coupleId, id);
    if (!existing || existing.status !== 'available') throw Errors.notFound('Món hàng không tồn tại');
    if (existing.createdBy.toString() !== userId) throw Errors.forbidden('Chỉ người đăng mới gỡ được món này');
    const doc = await marketRepository.archiveItem(coupleId, id, new Types.ObjectId(userId));
    if (!doc) throw Errors.notFound('Món hàng không tồn tại');
    await realtimeAudience.couple(coupleId, ['market']);
    logger.info('Market item archived', { coupleId: coupleId.toString(), userId, itemId: id });
  },

  /**
   * Partner asks to redeem an item. Coins are held immediately (atomic conditional $inc, so the
   * couple can never overspend — Requirement 9.5); they come back if the seller declines.
   */
  async request(couple: CoupleDoc, userId: string, itemId: string) {
    const item = await marketRepository.findItem(couple._id, itemId);
    if (!item || item.status !== 'available') throw Errors.notFound('Món hàng không tồn tại');
    if (item.createdBy.toString() === userId) {
      throw Errors.forbidden('Đây là món bạn đăng để người ấy đổi — bạn không tự đổi được');
    }
    const buyer = new Types.ObjectId(userId);
    if (await marketRepository.findOpenRequest(couple._id, item._id, buyer)) {
      throw Errors.conflict('Bạn đã gửi yêu cầu cho món này rồi, chờ người ấy trả lời nhé');
    }

    // Throws 422 with { missing } when the shared wallet is short (Requirement 10.3).
    const { balance } = await walletService.applyCoin({
      coupleId: couple._id,
      actorUserId: userId,
      delta: -item.priceCoin,
      reason: 'market_purchase',
      refId: item._id,
    });

    const red = await marketRepository.createRedemption({
      coupleId: couple._id,
      itemId: item._id,
      itemTitle: item.title,
      itemEmoji: item.emoji,
      buyerUserId: buyer,
      sellerUserId: item.createdBy,
      priceCoin: item.priceCoin,
    });
    await realtimeAudience.couple(couple._id, ['market']);
    logger.info('Redemption requested', {
      coupleId: couple._id.toString(),
      userId,
      itemId,
      redemptionId: red._id.toString(),
      priceCoin: item.priceCoin,
      balance,
    });
    await notificationService.toPartner(couple, buyer, {
      type: 'redemption_requested',
      entityId: red._id,
      push: {
        body: (name) => `${name} muốn đổi ${item.emoji} ${item.title} (${numberVi.format(item.priceCoin)} Xu), chờ bạn trả lời`,
        url: '/approvals',
        tag: `redemption:${red._id.toString()}`,
      },
    });
    return { redemption: redemptionView(red, userId, await memberNames(couple)), balance };
  },

  /** Seller agrees to perform the reward → it moves to the buyer's "waiting to be fulfilled" list. */
  async accept(couple: CoupleDoc, userId: string, id: string): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.sellerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người đăng món mới trả lời được yêu cầu này');
    if (r.status !== 'requested') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const updated = await marketRepository.transition(couple._id, r._id, 'requested', 'accepted', { respondedAt: new Date() });
    if (!updated) throw Errors.conflict('Yêu cầu này đã được xử lý');
    await realtimeAudience.couple(couple._id, ['market']);
    logger.info('Redemption accepted', { coupleId: couple._id.toString(), userId, redemptionId: id });
    await notifyAnswered(updated, (name) => `${name} đã đồng ý đổi ${updated.itemEmoji} ${updated.itemTitle} 🎁`);
    return redemptionView(updated, userId, await memberNames(couple));
  },

  /** Seller declines → coins return to the shared wallet. */
  async decline(couple: CoupleDoc, userId: string, id: string, note: string | null): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.sellerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người đăng món mới trả lời được yêu cầu này');
    if (r.status !== 'requested') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const updated = await marketRepository.transition(couple._id, r._id, 'requested', 'declined', {
      respondedAt: new Date(),
      responseNote: note?.trim() || null,
    });
    if (!updated) throw Errors.conflict('Yêu cầu này đã được xử lý');
    await realtimeAudience.couple(couple._id, ['market']);
    const balance = await refund(couple, userId, updated);
    logger.info('Redemption declined (refunded)', { coupleId: couple._id.toString(), userId, redemptionId: id, balance });
    await notifyAnswered(updated, (name) => `${name} chưa đồng ý đổi ${updated.itemEmoji} ${updated.itemTitle}. Xu đã được hoàn lại`);
    return redemptionView(updated, userId, await memberNames(couple));
  },

  /** Buyer withdraws a request the seller has not answered yet → coins return. */
  async cancel(couple: CoupleDoc, userId: string, id: string): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.buyerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người gửi yêu cầu mới rút lại được');
    if (r.status !== 'requested') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const updated = await marketRepository.transition(couple._id, r._id, 'requested', 'cancelled', { respondedAt: new Date() });
    if (!updated) throw Errors.conflict('Yêu cầu này đã được xử lý');
    await realtimeAudience.couple(couple._id, ['market']);
    const balance = await refund(couple, userId, updated);
    logger.info('Redemption cancelled (refunded)', { coupleId: couple._id.toString(), userId, redemptionId: id, balance });
    return redemptionView(updated, userId, await memberNames(couple));
  },

  /** Buyer confirms the reward was delivered. (The buyer decides — they received it.) */
  async fulfill(couple: CoupleDoc, userId: string, id: string): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.buyerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người đổi quà mới đánh dấu đã thực hiện');
    if (r.status !== 'accepted') throw Errors.conflict(r.status === 'fulfilled' ? 'Món này đã được đánh dấu xong' : 'Món này chưa được người ấy đồng ý');
    const updated = await marketRepository.transition(couple._id, r._id, 'accepted', 'fulfilled', { fulfilledAt: new Date() });
    if (!updated) throw Errors.conflict('Món này đã được xử lý');
    await realtimeAudience.couple(couple._id, ['market']);
    logger.info('Redemption fulfilled', { coupleId: couple._id.toString(), userId, redemptionId: id });
    return redemptionView(updated, userId, await memberNames(couple));
  },

  async history(couple: CoupleDoc, userId: string): Promise<RedemptionView[]> {
    const [rows, names] = await Promise.all([marketRepository.listRedemptions(couple._id), memberNames(couple)]);
    return rows.map((r) => redemptionView(r, userId, names));
  },

  /** Open requests (both directions); the client splits "I must answer" vs "waiting on partner". */
  async pending(couple: CoupleDoc, userId: string): Promise<RedemptionView[]> {
    const [rows, names] = await Promise.all([marketRepository.listByStatus(couple._id, 'requested'), memberNames(couple)]);
    return rows.map((r) => redemptionView(r, userId, names));
  },

  /** Market tab badge: my requests the partner answered + items the partner posted since I last looked. */
  async unreadCount(couple: CoupleDoc, userId: string) {
    const me = await userRepository.findById(userId);
    const since = me?.marketSeenAt ?? null;
    const uid = new Types.ObjectId(userId);
    const [responded, newItems] = await Promise.all([
      marketRepository.countRespondedSince(couple._id, uid, since),
      marketRepository.countItemsSince(couple._id, uid, since),
    ]);
    return { count: responded + newItems, responded, newItems };
  },

  async markSeen(userId: string): Promise<void> {
    await userRepository.setMarketSeenAt(userId, new Date());
    await realtimeAudience.own(userId, 'couple', ['market']);
  },
};
