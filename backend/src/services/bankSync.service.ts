import type { BankConnectionDoc } from '../models/BankConnection.js';
import { env } from '../config/env.js';
import { getBankFeed } from '../integrations/index.js';
import { BankFeedError, type BankFeedTxn } from '../integrations/bank/BankFeedProvider.js';
import { bankConnectionRepository } from '../repositories/bankConnection.repository.js';
import { bankTransactionRepository } from '../repositories/bankTransaction.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { assertSecretKey, decryptSecret } from '../utils/crypto.js';
import { getLocalDate } from '../utils/date.js';
import { logger } from '../utils/logger.js';
import { publishFinanceChange } from './financeRealtime.service.js';

/** Consecutive failed polls before a connection is parked in 'error' (user must retry). */
export const BANK_ERROR_THRESHOLD = 5;

export interface SyncOutcome {
  ok: boolean;
  fetched: number;
  inserted: number;
  /** Set when ok = false. */
  error?: { code: string; message: string };
}

function errorText(err: unknown): { code: string; message: string; fatal: boolean } {
  if (err instanceof BankFeedError) return { code: err.code, message: err.message, fatal: err.code === 'TOKEN_INVALID' };
  return { code: 'INTERNAL', message: 'Lỗi không xác định', fatal: false };
}

export const bankSyncService = {
  /** Store transactions we have not seen yet. Returns the number of new rows. */
  async ingest(conn: BankConnectionDoc, txns: BankFeedTxn[], onPersisted?: () => void): Promise<number> {
    if (txns.length === 0) return 0;
    const user = await userRepository.findById(conn.userId);
    const tz = user?.timezone ?? 'Asia/Ho_Chi_Minh';
    try {
      const inserted = await bankTransactionRepository.upsertMany(
        conn.userId,
        conn._id,
        txns.map((t) => ({ ...t, localDate: getLocalDate(t.occurredAt, tz) })),
      );
      if (inserted > 0) onPersisted?.();
      return inserted;
    } catch (err) {
      // An unordered Mongo bulk can acknowledge inserts before another row fails.
      const result = (err as { result?: { upsertedCount?: number } } | null)?.result;
      if (typeof result?.upsertedCount === 'number' && result.upsertedCount > 0) onPersisted?.();
      throw err;
    }
  },

  /** Poll one connection. Never throws for provider errors: the outcome + connection state record them. */
  async syncConnection(conn: BankConnectionDoc): Promise<SyncOutcome> {
    const userId = conn.userId.toString();
    if (!conn.tokenEnc || conn.status === 'revoked') {
      return { ok: false, fetched: 0, inserted: 0, error: { code: 'NOT_LINKED', message: 'Chưa liên kết ngân hàng' } };
    }
    const at = new Date();
    let persisted = false;
    const acknowledge = () => { persisted = true; };
    try {
      const txns = await getBankFeed().fetchRecent(decryptSecret(conn.tokenEnc));
      const inserted = await this.ingest(conn, txns, acknowledge);
      const updated = await bankConnectionRepository.recordSuccess(conn._id, at);
      if (updated) acknowledge();
      if (inserted > 0) logger.info('Bank transactions synced', { userId, fetched: txns.length, inserted });
      return { ok: true, fetched: txns.length, inserted };
    } catch (err) {
      const e = errorText(err);
      const updated = await bankConnectionRepository.recordFailure(
        conn._id,
        at,
        `${e.code}: ${e.message}`,
        BANK_ERROR_THRESHOLD,
        e.fatal,
        acknowledge,
      );
      if (updated) acknowledge();
      logger.warn('Bank sync failed', { userId, code: e.code, consecutiveErrors: updated?.consecutiveErrors, status: updated?.status });
      if (!(err instanceof BankFeedError)) logger.error('Bank sync crashed', { userId, message: (err as Error).message });
      return { ok: false, fetched: 0, inserted: 0, error: { code: e.code, message: e.message } };
    } finally {
      // Rejected/no-write polls are not changes; acknowledged partial imports are.
      if (persisted) await publishFinanceChange(userId);
    }
  },
};

// ── Background poll ──────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCycle(): Promise<void> {
  if (running) return; // never overlap cycles
  running = true;
  try {
    const conns = await bankConnectionRepository.listActive();
    const freshMs = (env.bank.pollIntervalSec * 1000) / 2;
    for (const conn of conns) {
      // Skip connections an on-demand sync refreshed very recently.
      if (conn.lastPolledAt && Date.now() - conn.lastPolledAt.getTime() < freshMs) continue;
      await bankSyncService.syncConnection(conn);
      await sleep(Math.floor(Math.random() * 3000)); // spread requests to thueapibank
    }
  } catch (err) {
    logger.error('Bank poll cycle failed', { message: (err as Error).message });
  } finally {
    running = false;
  }
}

/** Start polling. Only PM2 instance 0 (or a non-cluster process) polls; the unique index guards duplicates anyway. */
export function startBankSync(): void {
  assertSecretKey();
  getBankFeed(); // fail fast on a bad/forbidden BANK_PROVIDER
  const instance = process.env.NODE_APP_INSTANCE;
  if (instance !== undefined && instance !== '0') {
    logger.info('Bank poll disabled on this instance', { instance });
    return;
  }
  if (timer) return;
  const intervalMs = Math.max(30, env.bank.pollIntervalSec) * 1000;
  timer = setInterval(() => void runCycle(), intervalMs);
  setTimeout(() => void runCycle(), 10_000).unref();
  logger.info('Bank poll started', { intervalSec: intervalMs / 1000, provider: env.bank.provider });
}

export function stopBankSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
