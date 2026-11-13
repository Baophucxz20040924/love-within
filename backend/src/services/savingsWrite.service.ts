import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { observeSavingsWrite } from '../utils/monitor.js';

type LockOutcome = 'ok' | 'busy' | 'not_found' | 'rejected' | 'recovery_required';
function lockOutcome(err: unknown): LockOutcome {
  if (err instanceof AppError) {
    if (err.code === 'SAVINGS_BUSY') return 'busy';
    if (err.status === 404) return 'not_found';
    if (err.status < 500) return 'rejected';
  }
  return 'recovery_required';
}
import { Couple, type CoupleDoc } from '../models/Couple.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface SavingsWriteContext {
  couple: CoupleDoc;
  /** Only local post-release callbacks; never push while the token is held. */
  afterRelease: Array<() => Promise<void>>;
}
export const savingsBusy = () => new AppError(409, 'SAVINGS_BUSY', 'Quỹ đang được cập nhật. Thử lại sau; nếu vẫn bị khóa, hãy liên hệ quản trị viên.');
const recoveryRequired = () => new AppError(503, 'SAVINGS_RECOVERY_REQUIRED', 'Chưa xác định được kết quả ghi quỹ. Cần quản trị viên kiểm tra trước khi ghi tiếp.');

/** Standalone Mongo serialization, NOT a multi-document transaction. Never expires a live owner's token. */
export async function withSavingsWrite<T>(couple: CoupleDoc, userId: string, work: (ctx: SavingsWriteContext) => Promise<T>): Promise<T> {
  const token = randomUUID();
  const acquireStart = performance.now();
  let acquireOutcome: LockOutcome = 'ok';
  let fresh: CoupleDoc;
  try {
    // If acquisition itself has an ambiguous outcome, do not try to clear it.
    const acquired = await Couple.findOneAndUpdate({
      _id: couple._id, status: 'active', memberIds: userId, savingsWriteToken: null,
    }, { $set: { savingsWriteToken: token, savingsWriteStartedAt: new Date() } }, { new: true }).exec().catch(() => { throw recoveryRequired(); });
    if (!acquired) {
      const active = await Couple.exists({ _id: couple._id, status: 'active', memberIds: userId });
      if (!active) throw Errors.notFound('Couple không còn hoạt động');
      throw savingsBusy();
    }
    fresh = acquired;
  } catch (err) {
    acquireOutcome = lockOutcome(err);
    throw err;
  } finally {
    observeSavingsWrite('acquire', acquireOutcome, performance.now() - acquireStart);
  }
  const heldStart = performance.now();
  let heldOutcome: LockOutcome = 'ok';
  const ctx: SavingsWriteContext = { couple: fresh, afterRelease: [] };
  let value: T;
  let knownError: AppError | undefined;
  try {
    try {
      value = await work(ctx);
    } catch (err) {
      // Only explicit domain rejections have a known outcome. Unknown writes fail CLOSED.
      if (!(err instanceof AppError) || err.status >= 500) {
        logger.error('Savings write requires offline recovery');
        throw recoveryRequired();
      }
      knownError = err;
    }
    const released = await Couple.updateOne({ _id: couple._id, savingsWriteToken: token }, {
      $set: { savingsWriteToken: null, savingsWriteStartedAt: null },
    }).exec().catch(() => { throw recoveryRequired(); });
    if (released.modifiedCount !== 1) throw savingsBusy();
    if (knownError) heldOutcome = 'rejected';
  } catch (err) {
    heldOutcome = lockOutcome(err);
    throw err;
  } finally {
    // On recovery-required this is an observed interval, NOT a claim that the durable token was released.
    observeSavingsWrite('held', heldOutcome, performance.now() - heldStart);
  }
  // Notification latency is deliberately outside the held interval.
  for (const notify of ctx.afterRelease) {
    await notify().catch(() => logger.warn('Savings notification failed'));
  }
  if (knownError) throw knownError;
  return value!;
}
