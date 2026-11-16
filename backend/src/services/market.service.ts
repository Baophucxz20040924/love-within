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

/** Only a new durable refund intent authorizes a refund. Historical terminal rows never do. */
async function finishRefund(couple: CoupleDoc, r: MarketRedemptionDoc): Promise<MarketRedemptionDoc> {
  if (r.status !== 'refunding' || !r.refundIntent) return r;
  await walletService.applyCoin({ coupleId: couple._id, operationId: `market:${r._id}:refund`,
    actorUserId: r.refundIntent.actorUserId, ownerUserId: r.buyerUserId.toString(),
    delta: r.priceCoin, reason: 'market_refund', refId: r._id });
  return (await marketRepository.transition(couple._id, r._id, 'refunding', r.refundIntent.target)) ??
    await requireRedemption(couple, r._id.toString());
}

async function finishRequest(couple: CoupleDoc, userId: string, r: MarketRedemptionDoc) {
  if (r.status === 'reserving') {
    try {
      await walletService.applyCoin({ coupleId: couple._id, operationId: `market:${r._id}:debit`,
        actorUserId: r.buyerUserId.toString(), ownerUserId: r.buyerUserId.toString(),
        delta: -r.priceCoin, reason: 'market_purchase', refId: r._id });
    } catch (error) {
      // Only a durable rejected debit can close the reservation. Unknown outcomes stay recoverable.
      if ((error as { status?: number }).status === 422) await marketRepository.transition(couple._id, r._id, 'reserving', 'rejected');
      throw error;
    }
    r = (await marketRepository.transition(couple._id, r._id, 'reserving', 'requested')) ?? await requireRedemption(couple, r._id.toString());
  }
  if (r.status === 'rejected') throw Errors.unprocessable('Yêu cầu trước không đủ Xu. Hãy tạo yêu cầu mới.');
  const wallet = await walletService.getView(couple._id, userId);
  await realtimeAudience.couple(couple._id, ['market', 'wallet']);
  return { redemption: redemptionView(r, userId, await memberNames(couple)), balance: wallet.coinBalance };
}

async function recoverUnsettled(couple: CoupleDoc): Promise<void> {
  for (const row of await marketRepository.listUnsettled(couple._id)) {
    if (row.status === 'refunding') await finishRefund(couple, row);
    else {
      try { await finishRequest(couple, row.buyerUserId.toString(), row); }
      catch (error) { if ((error as { status?: number }).status !== 422) throw error; }
    }
  }
}

/** The seller answered: tell the buyer (never the response note). */
function notifyAnswered(r: MarketRedemptionDoc, body: (name: string) => string): Promise<void> {
  return notificationService.emit({
    space: 'couple', coupleId: r.coupleId,
    eventKey: `${r._id}:${r.status}`, target: { kind: 'approval', category: 'redemption', id: String(r._id) },
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
   * Reserve a stable redemption first, then debit only the buyer's balance through the fenced journal.
   * Coins are consumed, never paid to the seller; decline/cancel refunds the same buyer.
   */
  async request(couple: CoupleDoc, userId: string, itemId: string, requestKey: string) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey ?? '')) throw Errors.badRequest('Hãy tải lại ứng dụng để gửi mã yêu cầu đổi quà');
    const buyer = new Types.ObjectId(userId);
    const previous = await marketRepository.findRequest(couple._id, buyer, requestKey);
    if (previous) {
      if (String(previous.itemId) !== itemId) throw Errors.conflict('Mã yêu cầu đã dùng cho món khác');
      return finishRequest(couple, userId, previous);
    }
    await marketRepository.assertReservationIndexes();
    const item = await marketRepository.findItem(couple._id, itemId);
    if (!item || item.status !== 'available') throw Errors.notFound('Món hàng không tồn tại');
    if (item.createdBy.toString() === userId) throw Errors.forbidden('Bạn không thể đổi món của chính mình');
    const open = await marketRepository.findOpenRequest(couple._id, item._id, buyer);
    if (open) {
      // A concurrent retry can reserve this same key after the first lookup above.
      if (open.requestKey === requestKey) return finishRequest(couple, userId, open);
      throw Errors.conflict('Bạn đã có yêu cầu đang xử lý cho món này');
    }
    let red: MarketRedemptionDoc;
    try {
      // Reserve the immutable price, buyer, operation identity BEFORE debit. Unique indexes arbitrate races.
      red = await marketRepository.createRedemption({ _id: new Types.ObjectId(), requestKey, coupleId: couple._id,
        itemId: item._id, itemTitle: item.title, itemEmoji: item.emoji,
        buyerUserId: buyer, sellerUserId: item.createdBy, priceCoin: item.priceCoin });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await marketRepository.findRequest(couple._id, buyer, requestKey);
      if (!winner || String(winner.itemId) !== itemId) throw Errors.conflict('Bạn đã có yêu cầu đang xử lý cho món này');
      return finishRequest(couple, userId, winner);
    }
    const result = await finishRequest(couple, userId, red);
    await notificationService.toPartner(couple, buyer, { type: 'redemption_requested', entityId: red._id,
      eventKey: String(red._id), target: { kind: 'approval', category: 'redemption', id: String(red._id) },
      push: { body: (name) => `${name} muốn đổi ${item.emoji} ${item.title} (${numberVi.format(item.priceCoin)} Xu), chờ bạn trả lời`,
        url: '/approvals', tag: `redemption:${red._id}` } });
    return result;
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

  /** Seller declines → held coins return only to the buyer's personal wallet. */
  async decline(couple: CoupleDoc, userId: string, id: string, note: string | null): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.sellerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người đăng món mới trả lời được yêu cầu này');
    if (r.status === 'declined') return redemptionView(r, userId, await memberNames(couple));
    if (r.status !== 'requested' && r.status !== 'refunding') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const intent = r.status === 'refunding' ? r : await marketRepository.transition(couple._id, r._id, 'requested', 'refunding', {
      respondedAt: new Date(), responseNote: note?.trim() || null, refundIntent: { target: 'declined', actorUserId: userId },
    });
    if (!intent || intent.refundIntent?.target !== 'declined') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const updated = await finishRefund(couple, intent);
    await realtimeAudience.couple(couple._id, ['market', 'wallet']);
    await notifyAnswered(updated, (name) => `${name} chưa đồng ý đổi ${updated.itemEmoji} ${updated.itemTitle}. Xu đã hoàn về ví người mua`);
    return redemptionView(updated, userId, await memberNames(couple));
  },

  /** Buyer withdraws a request the seller has not answered yet → coins return. */
  async cancel(couple: CoupleDoc, userId: string, id: string): Promise<RedemptionView> {
    const r = await requireRedemption(couple, id);
    if (r.buyerUserId.toString() !== userId) throw Errors.forbidden('Chỉ người gửi yêu cầu mới rút lại được');
    if (r.status === 'cancelled') return redemptionView(r, userId, await memberNames(couple));
    if (r.status !== 'requested' && r.status !== 'refunding') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const intent = r.status === 'refunding' ? r : await marketRepository.transition(couple._id, r._id, 'requested', 'refunding', {
      respondedAt: new Date(), refundIntent: { target: 'cancelled', actorUserId: userId },
    });
    if (!intent || intent.refundIntent?.target !== 'cancelled') throw Errors.conflict('Yêu cầu này đã được xử lý');
    const updated = await finishRefund(couple, intent);
    await realtimeAudience.couple(couple._id, ['market', 'wallet']);
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
    await recoverUnsettled(couple);
    const [rows, names] = await Promise.all([marketRepository.listRedemptions(couple._id), memberNames(couple)]);
    const visible: RedemptionView[] = [];
    for (let row of rows) {
      if (row.status === 'reserving') {
        try { await finishRequest(couple, row.buyerUserId.toString(), row); }
        catch (error) { if ((error as { status?: number }).status !== 422) throw error; }
        row = await requireRedemption(couple, row._id.toString());
      }
      if (row.status === 'refunding') row = await finishRefund(couple, row);
      if (row.status !== 'reserving' && row.status !== 'rejected') visible.push(redemptionView(row, userId, names));
    }
    return visible;
  },

  /** Open requests (both directions); the client splits "I must answer" vs "waiting on partner". */
  async pending(couple: CoupleDoc, userId: string): Promise<RedemptionView[]> {
    await recoverUnsettled(couple);
    const [rows, names] = await Promise.all([marketRepository.listByStatus(couple._id, 'requested'), memberNames(couple)]);
    const visible: RedemptionView[] = [];
    for (let row of rows) {
      if (row.status === 'reserving') {
        try { await finishRequest(couple, row.buyerUserId.toString(), row); }
        catch (error) { if ((error as { status?: number }).status !== 422) throw error; }
        row = await requireRedemption(couple, row._id.toString());
      }
      if (row.status === 'refunding') row = await finishRefund(couple, row);
      if (row.status !== 'reserving' && row.status !== 'rejected') visible.push(redemptionView(row, userId, names));
    }
    return visible;
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
