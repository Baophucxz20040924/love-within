import { Types } from 'mongoose';
import type { CoupleNotificationDoc, CoupleNotificationTarget } from '../models/CoupleNotification.js';
import { coupleNotificationRepository, type CoupleNotificationCursor, type CoupleNotificationScope } from '../repositories/coupleNotification.repository.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import type { RealtimeDomain } from './realtime.service.js';

const PAGE = 20;
const MAX_BADGE = 99;
export const MAX_NOTIFICATION_WATERMARKS = 25;
const objectId = /^[a-f\d]{24}$/i;
export interface CoupleNotificationView {
  id: string;
  type: CoupleNotificationDoc['type'];
  actorId: string | null;
  entityId: string | null;
  target: CoupleNotificationTarget;
  read: boolean;
  createdAt: string;
}

/** Re-resolve current membership for EVERY operation, never accept a couple from the client or cached request. */
async function scopeFor(userId: string): Promise<CoupleNotificationScope> {
  const user = await userRepository.findById(userId);
  if (!user) throw Errors.unauthorized();
  const couple = user.coupleId ? await coupleRepository.findActiveById(user.coupleId) : null;
  if (!couple || !couple.memberIds.some((id) => id.equals(user._id))) {
    throw new AppError(403, 'NO_COUPLE', 'Bạn chưa ghép đôi hoặc couple không còn hoạt động');
  }
  return { userId: user._id, coupleId: couple._id };
}
function cursorOf(doc: CoupleNotificationDoc): string { return `${doc.createdAt.getTime()}_${doc._id}`; }
function parseCursor(value?: string): CoupleNotificationCursor | null {
  if (value === undefined) return null;
  const match = /^(\d{1,15})_([a-f\d]{24})$/i.exec(value);
  const at = match ? new Date(Number(match[1])) : new Date(NaN);
  if (!match || !Number.isFinite(at.getTime())) throw Errors.badRequest('Cursor không hợp lệ');
  return { at, id: new Types.ObjectId(match[2]) };
}
export async function invalidateCoupleNotifications(userId: Types.ObjectId, badgeOnly = false): Promise<void> {
  const domains: RealtimeDomain[] = badgeOnly ? ['couple-notification-unread'] : ['couple-notifications', 'couple-notification-unread'];
  await realtimeAudience.own(String(userId), 'couple', domains).catch(() => {});
}
async function invalidateRead(userId: Types.ObjectId): Promise<void> {
  await realtimeAudience.own(String(userId), 'couple', ['couple-notifications']).catch(() => {});
}
async function acknowledge(userId: string, watermarks: string[], field: 'seenAt' | 'readAt'): Promise<void> {
  const scope = await scopeFor(userId);
  if (!Array.isArray(watermarks) || !watermarks.length || watermarks.length > MAX_NOTIFICATION_WATERMARKS ||
      watermarks.some((token) => typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token))) throw Errors.badRequest('Mốc thông báo không hợp lệ');
  const ids = await coupleNotificationRepository.observedIds(scope, watermarks);
  if (!ids) throw Errors.badRequest('Mốc thông báo đã hết hạn. Hãy tải lại danh sách.');
  if (!await coupleNotificationRepository.markObserved(scope, ids, field)) return;
  // Seeing a feed must never invalidate that feed and start an acknowledgement/refetch loop.
  if (field === 'seenAt') await invalidateCoupleNotifications(scope.userId, true);
  else await invalidateRead(scope.userId);
}

export const coupleNotificationsService = {
  async list(userId: string, cursor?: string) {
    const scope = await scopeFor(userId);
    const docs = await coupleNotificationRepository.list(scope, parseCursor(cursor), PAGE);
    const page = docs.slice(0, PAGE);
    const watermark = await coupleNotificationRepository.observe(scope, page.map((doc) => doc._id));
    const items: CoupleNotificationView[] = page.map((doc) => ({
      id: String(doc._id), type: doc.type, actorId: doc.actorId ? String(doc.actorId) : null,
      entityId: doc.entityId ? String(doc.entityId) : null, target: doc.target,
      read: doc.readAt !== null, createdAt: doc.createdAt.toISOString(),
    }));
    return { items, nextCursor: docs.length > PAGE ? cursorOf(page[page.length - 1]) : null, watermark };
  },
  async unread(userId: string) {
    const count = await coupleNotificationRepository.unseen(await scopeFor(userId), MAX_BADGE + 1);
    return { notifications: Math.min(count, MAX_BADGE), notificationsSaturated: count > MAX_BADGE };
  },
  seen(userId: string, watermarks: string[]) { return acknowledge(userId, watermarks, 'seenAt'); },
  /** Deliberately reads only returned pages, not hidden history or arrivals racing an open inbox. */
  readAll(userId: string, watermarks: string[]) { return acknowledge(userId, watermarks, 'readAt'); },
  async read(userId: string, id: string): Promise<void> {
    const scope = await scopeFor(userId);
    if (!objectId.test(id)) throw Errors.badRequest('ID không hợp lệ');
    const result = await coupleNotificationRepository.markRead(scope, new Types.ObjectId(id));
    if (!result.found) throw Errors.notFound('Thông báo không tồn tại');
    if (result.changed) await invalidateRead(scope.userId);
  },
};
