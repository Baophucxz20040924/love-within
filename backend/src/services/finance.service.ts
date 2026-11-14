import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import type { BankConnectionDoc, BankConnectionStatus } from '../models/BankConnection.js';
import type { BankTransactionDoc, TxnDirection } from '../models/BankTransaction.js';
import type { FinanceVisibility } from '../models/User.js';
import { getBankFeed } from '../integrations/index.js';
import { BankFeedError } from '../integrations/bank/BankFeedProvider.js';
import { bankConnectionRepository } from '../repositories/bankConnection.repository.js';
import { bankTransactionRepository } from '../repositories/bankTransaction.repository.js';
import { assistantThreadRepository } from '../repositories/assistantThread.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { bankSyncService, type SyncOutcome } from './bankSync.service.js';
import { encryptSecret } from '../utils/crypto.js';
import { getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { publishFinanceChange } from './financeRealtime.service.js';

/** On-demand syncs closer together than this reuse the last poll (no extra call to thueapibank). */
const MIN_SYNC_GAP_MS = 60_000;

export interface ConnectionView {
  linked: boolean;
  status: BankConnectionStatus | null;
  bankBrand: string | null;
  accountLast4: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  visibility: FinanceVisibility;
}

export interface TxnView {
  id: string;
  direction: TxnDirection;
  amount: number;
  occurredAt: string;
  localDate: string;
  note: string;
  isMine: boolean;
}

export interface TxnPage {
  items: TxnView[];
  nextCursor: string | null;
}

export interface SummaryView {
  month: string;
  totalIn: number;
  totalOut: number;
  net: number;
  count: number;
}

export interface ListQuery {
  month?: string;
  direction?: TxnDirection;
  cursor?: string;
  limit: number;
}

function connectionView(conn: BankConnectionDoc | null, visibility: FinanceVisibility): ConnectionView {
  const linked = !!conn && conn.status !== 'revoked';
  return {
    linked,
    status: conn?.status ?? null,
    bankBrand: linked ? conn!.bankBrand : null,
    accountLast4: linked ? conn!.accountLast4 : null,
    lastSuccessAt: linked ? (conn!.lastSuccessAt?.toISOString() ?? null) : null,
    lastError: linked ? conn!.lastError : null,
    visibility,
  };
}

function txnView(t: BankTransactionDoc, isMine: boolean): TxnView {
  return {
    id: t._id.toString(),
    direction: t.direction,
    amount: t.amount,
    occurredAt: t.occurredAt.toISOString(),
    localDate: t.localDate,
    note: t.note,
    isMine,
  };
}

async function loadUser(userId: string | Types.ObjectId) {
  const user = await userRepository.findById(userId);
  if (!user) throw Errors.unauthorized();
  return user;
}

function partnerOf(couple: CoupleDoc, userId: string): Types.ObjectId {
  const p = couple.memberIds.find((m) => m.toString() !== userId);
  if (!p) throw Errors.notFound('Không tìm thấy người ấy');
  return p;
}

/** Map a provider failure during linking to an HTTP error the wizard can show. */
function linkError(err: unknown): AppError {
  if (err instanceof BankFeedError) {
    if (err.code === 'TOKEN_INVALID') {
      return new AppError(422, 'BANK_TOKEN_INVALID', 'Token không hợp lệ. Hãy copy lại cột TOKEN trên thueapibank.vn.');
    }
    if (err.retryable) return new AppError(503, 'BANK_UNAVAILABLE', 'Chưa kết nối được thueapibank, thử lại sau ít phút.');
    return new AppError(422, 'BANK_PROVIDER_ERROR', `thueapibank báo lỗi: ${err.message}`);
  }
  return Errors.internal();
}

async function page(userId: Types.ObjectId, q: ListQuery, isMine: boolean): Promise<TxnPage> {
  const rows = await bankTransactionRepository.list(userId, q);
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map((t) => txnView(t, isMine));
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

async function summary(userId: Types.ObjectId, timezone: string, month?: string): Promise<SummaryView> {
  const m = month ?? getLocalDate(new Date(), timezone).slice(0, 7);
  const s = await bankTransactionRepository.summary(userId, m);
  return { month: m, totalIn: s.totalIn, totalOut: s.totalOut, net: s.totalIn - s.totalOut, count: s.count };
}

/** Partner data is readable only when the partner opted in. Private is checked first so we never leak "linked or not". */
async function readablePartner(couple: CoupleDoc, userId: string) {
  const partner = await loadUser(partnerOf(couple, userId));
  if (partner.financeVisibility !== 'partner') {
    throw new AppError(403, 'FINANCE_PRIVATE', 'Người ấy đang để dòng tiền ở chế độ riêng tư');
  }
  // A revoked connection still counts: the partner chose to keep and share past data.
  if (!(await bankConnectionRepository.findByUser(partner._id))) {
    throw new AppError(404, 'FINANCE_NOT_LINKED', 'Người ấy chưa liên kết ngân hàng');
  }
  return partner;
}

export const financeService = {
  async getConnection(userId: string): Promise<ConnectionView> {
    const [user, conn] = await Promise.all([loadUser(userId), bankConnectionRepository.findByUser(userId)]);
    return connectionView(conn, user.financeVisibility);
  },

  /** Validate the token against the provider, store it encrypted, import what the feed returns (~7 days). */
  async connect(userId: string, input: { token: string; accountLast4: string }): Promise<{ connection: ConnectionView; imported: number }> {
    const user = await loadUser(userId);
    const existing = await bankConnectionRepository.findByUser(userId);
    if (existing && existing.status !== 'revoked') {
      throw new AppError(409, 'BANK_ALREADY_LINKED', 'Bạn đã liên kết ngân hàng. Ngắt kết nối trước khi liên kết tài khoản khác.');
    }

    let txns;
    try {
      txns = await getBankFeed().fetchRecent(input.token);
    } catch (err) {
      logger.warn('Bank link rejected', { userId, code: err instanceof BankFeedError ? err.code : 'INTERNAL' });
      throw linkError(err);
    }

    const conn = await bankConnectionRepository.upsertActive(userId, {
      accountLast4: input.accountLast4,
      tokenEnc: encryptSecret(input.token),
      at: new Date(),
    });
    try {
      const imported = await bankSyncService.ingest(conn, txns);
      logger.info('Bank connected', { userId, provider: conn.provider, fetched: txns.length, imported, relinked: !!existing });
      return { connection: connectionView(conn, user.financeVisibility), imported };
    } finally {
      // The connection was persisted even if importing transactions failed.
      await publishFinanceChange(userId);
    }
  },

  /** Called when the finance page opens and by "Thử lại". Throttled to one provider call per minute per user. */
  async syncNow(userId: string): Promise<{ connection: ConnectionView; synced: boolean; inserted: number; error: SyncOutcome['error'] | null }> {
    const user = await loadUser(userId);
    const conn = await bankConnectionRepository.findByUser(userId);
    if (!conn || conn.status === 'revoked') throw new AppError(404, 'FINANCE_NOT_LINKED', 'Bạn chưa liên kết ngân hàng');

    const recent = conn.lastPolledAt && Date.now() - conn.lastPolledAt.getTime() < MIN_SYNC_GAP_MS;
    if (recent && conn.status === 'active') {
      return { connection: connectionView(conn, user.financeVisibility), synced: false, inserted: 0, error: null };
    }
    const outcome = await bankSyncService.syncConnection(conn);
    const fresh = await bankConnectionRepository.findByUser(userId);
    return { connection: connectionView(fresh, user.financeVisibility), synced: outcome.ok, inserted: outcome.inserted, error: outcome.error ?? null };
  },

  /** Drop the token. Transactions are kept unless `purge`. */
  async disconnect(userId: string, purge: boolean): Promise<{ connection: ConnectionView; deleted: number }> {
    const user = await loadUser(userId);
    const conn = await bankConnectionRepository.revoke(userId);
    if (!conn) throw new AppError(404, 'FINANCE_NOT_LINKED', 'Bạn chưa liên kết ngân hàng');
    try {
      const deleted = purge ? await bankTransactionRepository.deleteAllForUser(user._id) : 0;
      // Purging the data also drops what the AI assistant derived from it.
      if (purge) await assistantThreadRepository.deleteByUser(user._id);
      logger.info('Bank disconnected', { userId, purge, deleted });
      return { connection: connectionView(conn, user.financeVisibility), deleted };
    } finally {
      await publishFinanceChange(userId, { access: purge });
    }
  },

  async setVisibility(userId: string, visibility: FinanceVisibility): Promise<{ visibility: FinanceVisibility }> {
    await loadUser(userId);
    await userRepository.setFinanceVisibility(userId, visibility);
    await publishFinanceChange(userId, { visibilityChanged: true, access: true });
    logger.info('Finance visibility changed', { userId, visibility });
    return { visibility };
  },

  listMine(userId: string, q: ListQuery): Promise<TxnPage> {
    return page(new Types.ObjectId(userId), q, true);
  },

  async summaryMine(userId: string, month?: string): Promise<SummaryView> {
    const user = await loadUser(userId);
    return summary(user._id, user.timezone, month);
  },

  async setNote(userId: string, id: string, note: string): Promise<TxnView> {
    const t = await bankTransactionRepository.updateNote(new Types.ObjectId(userId), id, note);
    if (!t) throw Errors.notFound('Giao dịch không tồn tại');
    await publishFinanceChange(userId);
    return txnView(t, true);
  },

  async listPartner(couple: CoupleDoc, userId: string, q: ListQuery): Promise<TxnPage> {
    const partner = await readablePartner(couple, userId);
    return page(partner._id, q, false);
  },

  async summaryPartner(couple: CoupleDoc, userId: string, month?: string): Promise<SummaryView> {
    const partner = await readablePartner(couple, userId);
    return summary(partner._id, partner.timezone, month);
  },
};
