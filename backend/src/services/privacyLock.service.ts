import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrivacyLock } from '../models/PrivacyLock.js';
import { User } from '../models/User.js';
import { AppError, Errors } from '../utils/errors.js';

export type PrivacySpace = 'couple' | 'friends';
type Budget = 'unlockBudget' | 'reauthBudget';
const ROUNDS = 11;
const LEASE_MS = 60_000;
const LOCK_MESSAGE = 'Thao tác quá nhanh, vui lòng thử lại sau.';
let dummyHash: Promise<string> | undefined;
const dummy = () => (dummyHash ??= bcrypt.hash('privacy-lock-dummy-verifier', ROUNDS));

function retry(seconds: number): AppError {
  return new AppError(429, 'TOO_MANY_REQUESTS', LOCK_MESSAGE, { retryAfterSeconds: Math.max(1, seconds) });
}

async function ensureRow(userId: string): Promise<void> {
  try {
    await PrivacyLock.updateOne({ userId }, { $setOnInsert: { userId } }, { upsert: true, setDefaultsOnInsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

/** A reservation is charged as a failure before bcrypt. An abandoned lease therefore fails closed. */
async function reserve(userId: string, budget: Budget) {
  await ensureRow(userId);
  const now = new Date();
  const leaseId = randomUUID();
  const failures = `$${budget}.failures`;
  const nextFailures = { $add: [{ $ifNull: [failures, 0] }, 1] };
  // 5th attempt triggers 30s; each further charged attempt doubles the delay, capped at 15m.
  const delay = { $min: [900_000, { $multiply: [30_000, { $pow: [2, { $min: [5, { $max: [0, { $subtract: [nextFailures, 5] }] }] }] }] }] };
  const row = await PrivacyLock.findOneAndUpdate({
    userId,
    $and: [
      { $or: [{ [`${budget}.blockedUntil`]: null }, { [`${budget}.blockedUntil`]: { $lte: now } }] },
      { $or: [{ [`${budget}.leaseUntil`]: null }, { [`${budget}.leaseUntil`]: { $lte: now } }] },
    ],
  }, [{ $set: {
    [`${budget}.failures`]: nextFailures,
    [`${budget}.blockedUntil`]: { $cond: [{ $gte: [nextFailures, 5] }, { $add: [now, delay] }, null] },
    [`${budget}.leaseId`]: leaseId,
    [`${budget}.leaseUntil`]: new Date(now.getTime() + LEASE_MS),
  } }], { new: true }).select('+coupleHash +friendsHash +unlockBudget +reauthBudget').lean();
  if (row) return { row, leaseId };
  const current = await PrivacyLock.findOne({ userId }).select('+unlockBudget +reauthBudget').lean();
  if (!current) throw Errors.internal();
  const state = current[budget];
  const until = Math.max(state?.blockedUntil?.getTime() ?? 0, state?.leaseUntil?.getTime() ?? 0);
  throw retry(Math.ceil((until - Date.now()) / 1000));
}

/** Completion requires the same live lease and config revision; stale work cannot grant or reset. */
async function complete(userId: string, budget: Budget, leaseId: string, revision: number, success: boolean): Promise<boolean> {
  const changes: Record<string, unknown> = {
    [`${budget}.leaseId`]: null,
    [`${budget}.leaseUntil`]: null,
  };
  if (success) {
    changes[`${budget}.failures`] = 0;
    changes[`${budget}.blockedUntil`] = null;
  }
  const result = await PrivacyLock.updateOne({
    userId, revision,
    [`${budget}.leaseId`]: leaseId,
    [`${budget}.leaseUntil`]: { $gt: new Date() },
  }, { $set: changes });
  return result.modifiedCount === 1;
}

async function verifyPassword(userId: string, password: string): Promise<void> {
  const { row, leaseId } = await reserve(userId, 'reauthBudget');
  const user = await User.findById(userId).select('passwordHash').lean();
  const valid = await bcrypt.compare(password, user?.passwordHash ?? await dummy());
  const completed = await complete(userId, 'reauthBudget', leaseId, row.revision, !!user && valid);
  if (!completed) throw Errors.conflict('Cấu hình đã thay đổi, vui lòng tải lại.');
  if (!user || !valid) throw new AppError(400, 'INVALID_PASSWORD', 'Mật khẩu không đúng.');
}

export const privacyLockService = {
  async status(userId: string) {
    const row = await PrivacyLock.findOne({ userId }).select('couple friends revision -_id').lean();
    return { couple: row?.couple ?? false, friends: row?.friends ?? false, revision: row?.revision ?? 0 };
  },

  async configure(userId: string, space: PrivacySpace, password: string, revision: number, pin?: string) {
    await verifyPassword(userId, password);
    const row = await PrivacyLock.findOne({ userId }).select('+coupleHash +friendsHash').lean();
    if (!row || row.revision !== revision) throw Errors.conflict('Cấu hình đã thay đổi, vui lòng tải lại.');
    if (pin !== undefined && space === 'friends') {
      const user = await User.findById(userId).select('friendsJoinedAt').lean();
      if (!user?.friendsJoinedAt) throw Errors.forbidden('Không thể thiết lập mã này.');
    }
    let hash: string | null = null;
    if (pin !== undefined) {
      const otherHash = space === 'couple' ? row.friendsHash : row.coupleHash;
      if (await bcrypt.compare(pin, otherHash ?? await dummy())) {
        throw Errors.badRequest('Mã này không dùng được, hãy chọn mã khác.');
      }
      hash = await bcrypt.hash(pin, ROUNDS);
    }
    const result = await PrivacyLock.updateOne({ userId, revision }, { $set: {
      [space]: pin !== undefined,
      [`${space}Hash`]: hash,
      // Invalidate in-flight unlocks, including a matching verifier from the previous revision.
      'unlockBudget.leaseId': null,
      'unlockBudget.leaseUntil': null,
    }, $inc: { revision: 1 } });
    if (result.modifiedCount !== 1) throw Errors.conflict('Cấu hình đã thay đổi, vui lòng tải lại.');
    return { couple: space === 'couple' ? pin !== undefined : row.couple,
      friends: space === 'friends' ? pin !== undefined : row.friends, revision: revision + 1 };
  },

  async unlock(userId: string, pin: string) {
    const { row, leaseId } = await reserve(userId, 'unlockBudget');
    const fallback = (!row.coupleHash || !row.friendsHash) ? await dummy() : '';
    const [coupleMatch, friendsMatch] = await Promise.all([
      bcrypt.compare(pin, row.coupleHash ?? fallback),
      bcrypt.compare(pin, row.friendsHash ?? fallback),
    ]);
    const space: PrivacySpace | null = row.couple && coupleMatch ? 'couple' : row.friends && friendsMatch ? 'friends' : null;
    const completed = await complete(userId, 'unlockBudget', leaseId, row.revision, space !== null);
    if (!completed) throw Errors.conflict('Cấu hình đã thay đổi, vui lòng tải lại.');
    if (!space) throw new AppError(400, 'INVALID_PIN', 'Mã không đúng.');
    return { space, revision: row.revision };
  },
};
