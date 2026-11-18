import { realtimeAudience } from './realtimeAudience.service.js';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { CoupleDoc } from '../models/Couple.js';
import type { WaterLogDoc, WaterLogStatus, WaterSource } from '../models/WaterLog.js';
import { getStorage, getVision } from '../integrations/index.js';
import { WaterVisionError } from '../integrations/ai/WaterVisionProvider.js';
import { waterRepository } from '../repositories/water.repository.js';
import { coupleSettingsRepository } from '../repositories/coupleSettings.repository.js';
import { proposalRepository } from '../repositories/proposal.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { questService } from './quest.service.js';
import { notificationService } from './notification.service.js';
import { getLocalDate } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const numberVi = new Intl.NumberFormat('vi-VN');

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export const MAX_MANUAL_ML = 3000;
export const MANUAL_PROOF_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};
/** Header plausibility only, not a full image decoder or malware scan. Never read the full object. */
export const MANUAL_PROOF_PREFIX_BYTES = 32;
export type WaterUploadPurpose = 'ai' | 'manual_proof';

export interface WaterLogView {
  id: string;
  userId: string;
  amountMl: number;
  source: WaterSource;
  hasImage: boolean;
  status: WaterLogStatus;
  reviewedBy: string | null;
  localDate: string;
  createdAt: string;
}

export interface PendingWaterView extends WaterLogView {
  submitterName: string;
}

export interface WaterToday {
  localDate: string;
  /** Approved ml only — this is what counts toward the goal and the quest. */
  totalMl: number;
  /** Caller's submissions still waiting for the partner. */
  pendingMl: number;
  goalMl: number | null;
  goalMet: boolean;
  remainingMl: number | null;
  logs: WaterLogView[];
  pendingGoalProposal: boolean;
}

export interface WaterSubmitResult {
  logId: string;
  amountMl: number;
  status: 'pending';
  totalMl: number;
  pendingMl: number;
  goalMl: number | null;
}

export interface WaterReviewResult {
  logId: string;
  status: 'approved' | 'rejected';
  amountMl: number;
  /** Submitter's approved total for the log's day, after this review. */
  totalMl: number;
  goalMl: number | null;
  goalMet: boolean;
}

function statusOf(l: WaterLogDoc): WaterLogStatus {
  // Rows created before approvals existed have no status; they were counted on creation.
  return l.status ?? 'approved';
}

function toView(l: WaterLogDoc): WaterLogView {
  return {
    id: l._id.toString(),
    userId: l.userId.toString(),
    amountMl: l.amountMl,
    source: l.source,
    hasImage: Boolean(l.imageKey),
    status: statusOf(l),
    reviewedBy: l.reviewedBy ? l.reviewedBy.toString() : null,
    localDate: l.localDate,
    createdAt: l.createdAt.toISOString(),
  };
}

function keyPrefix(coupleId: Types.ObjectId): string {
  return `couples/${coupleId.toString()}/water/`;
}

/** Reject any key not belonging to this couple (prevents cross-couple reads/writes). */
function assertOwnKey(coupleId: Types.ObjectId, imageKey: string): void {
  if (!imageKey.startsWith(keyPrefix(coupleId)) || imageKey.includes('..')) {
    logger.warn('Rejected foreign imageKey', { coupleId: coupleId.toString(), imageKey });
    throw Errors.forbidden('imageKey không thuộc couple của bạn');
  }
}

function proofPrefix(coupleId: Types.ObjectId, userId: string): string {
  // A sibling of /water/, not a child: AI photo submissions cannot consume manual proof keys.
  return `couples/${coupleId.toString()}/water-proofs/${userId}/`;
}

function assertProofKey(coupleId: Types.ObjectId, userId: string, key: string): string {
  const prefix = proofPrefix(coupleId, userId);
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  const match = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\/[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.(jpg|png|webp)$/.exec(suffix);
  if (!match || match[0] !== suffix || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) {
    throw Errors.forbidden('Ảnh minh chứng không thuộc bạn hoặc đường dẫn không hợp lệ');
  }
  return match[2];
}

function plausibleProof(bytes: Buffer, ext: string, size: number): boolean {
  if (ext === 'jpg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0 && bytes[3] !== 0xff;
  if (ext === 'png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  return bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === size &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}

async function validateManualProof(couple: CoupleDoc, userId: string, key: string): Promise<void> {
  const ext = assertProofKey(couple._id, userId, key);
  const storage = getStorage();
  const head = await storage.headObject(key);
  if (!head) throw Errors.badRequest('Ảnh minh chứng chưa tải lên xong. Hãy thử lại.');
  if (!Number.isSafeInteger(head.size) || head.size <= 0 || head.size > env.s3.maxUploadBytes) {
    throw Errors.badRequest('Ảnh minh chứng trống hoặc vượt kích thước cho phép');
  }
  if (!Object.hasOwn(MANUAL_PROOF_TYPES, head.mimeType) || MANUAL_PROOF_TYPES[head.mimeType] !== ext) {
    throw Errors.badRequest('Định dạng ảnh minh chứng không khớp với tệp đã tải lên');
  }
  const bytes = await storage.getObjectPrefix(key, MANUAL_PROOF_PREFIX_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length > MANUAL_PROOF_PREFIX_BYTES || bytes.length > head.size || !plausibleProof(bytes, ext, head.size)) {
    throw Errors.badRequest('Tệp minh chứng không có phần đầu ảnh JPEG/PNG/WebP hợp lệ');
  }
}

async function sumPending(couple: CoupleDoc, userId: Types.ObjectId, localDate: string): Promise<number> {
  const logs = await waterRepository.listLogs(couple._id, userId, localDate);
  return logs.filter((l) => statusOf(l) === 'pending').reduce((s, l) => s + l.amountMl, 0);
}

/** Record a submission as PENDING. Nothing is added to the daily total until the partner approves. */
async function submit(
  couple: CoupleDoc,
  userId: string,
  amountMl: number,
  source: WaterSource,
  imageKey: string | null,
  aiRaw: Record<string, unknown> | null,
): Promise<WaterSubmitResult> {
  const localDate = getLocalDate(new Date(), couple.timezone);
  const uid = new Types.ObjectId(userId);
  const log = await waterRepository.createLog({
    coupleId: couple._id,
    userId: uid,
    localDate,
    amountMl,
    source,
    aiRaw,
    imageKey,
    status: 'pending',
  });
  await realtimeAudience.couple(couple._id, ['water']);
  const [daily, pendingMl, settings] = await Promise.all([
    waterRepository.getDaily(couple._id, uid, localDate),
    sumPending(couple, uid, localDate),
    coupleSettingsRepository.getOrCreate(couple._id),
  ]);
  logger.info('Water submitted for partner approval', {
    coupleId: couple._id.toString(),
    userId,
    logId: log._id.toString(),
    amountMl,
    source,
  });
  await notificationService.toPartner(couple, uid, {
    type: 'water_pending',
    entityId: log._id, eventKey: String(log._id),
    target: { kind: 'approval', category: 'water', id: String(log._id) },
    push: { body: (name) => `${name} vừa uống ${numberVi.format(amountMl)} ml, chờ bạn duyệt 💧`, url: '/approvals', tag: 'water' },
  });
  return {
    logId: log._id.toString(),
    amountMl,
    status: 'pending',
    totalMl: daily?.totalMl ?? 0,
    pendingMl,
    goalMl: settings.waterGoalMl,
  };
}

export const waterService = {
  async today(couple: CoupleDoc, userId: string): Promise<WaterToday> {
    const localDate = getLocalDate(new Date(), couple.timezone);
    const uid = new Types.ObjectId(userId);
    const [settings, daily, logs, pendingGoal] = await Promise.all([
      coupleSettingsRepository.getOrCreate(couple._id),
      waterRepository.getDaily(couple._id, uid, localDate),
      waterRepository.listLogs(couple._id, uid, localDate),
      proposalRepository.findPendingByKind(couple._id, 'water_goal'),
    ]);
    const views = logs.map(toView);
    const totalMl = daily?.totalMl ?? 0;
    const goalMl = settings.waterGoalMl;
    return {
      localDate,
      totalMl,
      pendingMl: views.filter((v) => v.status === 'pending').reduce((s, v) => s + v.amountMl, 0),
      goalMl,
      goalMet: goalMl !== null && totalMl >= goalMl,
      remainingMl: goalMl !== null ? Math.max(0, goalMl - totalMl) : null,
      logs: views,
      pendingGoalProposal: Boolean(pendingGoal),
    };
  },

  /** Pending submissions of both members (the frontend splits "needs my review" vs "waiting on partner"). */
  async pending(couple: CoupleDoc): Promise<PendingWaterView[]> {
    const [logs, names] = await Promise.all([
      waterRepository.listPending(couple._id),
      userRepository.findDisplayNames(couple.memberIds),
    ]);
    return logs.map((l) => ({ ...toView(l), submitterName: names.get(l.userId.toString()) ?? 'Người ấy' }));
  },

  /** Step 1: issue a presigned PUT. The key is couple-prefixed and server-generated. */
  async createUploadUrl(couple: CoupleDoc, userId: string, mimeType: string, sizeBytes: number, purpose: WaterUploadPurpose = 'ai') {
    if (purpose !== 'ai' && purpose !== 'manual_proof') throw Errors.badRequest('Mục đích tải ảnh không hợp lệ');
    if (!couple.memberIds.some((id) => id.toString() === userId)) throw Errors.forbidden('Bạn không thuộc couple này');
    const types = purpose === 'manual_proof' ? MANUAL_PROOF_TYPES : ALLOWED_IMAGE_TYPES;
    const ext = Object.hasOwn(types, mimeType) ? types[mimeType] : undefined;
    if (!ext) throw Errors.badRequest(purpose === 'manual_proof' ? 'Minh chứng chỉ chấp nhận ảnh JPEG/PNG/WebP' : 'Chỉ chấp nhận ảnh JPEG/PNG/WebP/HEIC');
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const localDate = getLocalDate(new Date(), couple.timezone);
    const prefix = purpose === 'manual_proof' ? proofPrefix(couple._id, userId) : keyPrefix(couple._id);
    const imageKey = `${prefix}${localDate}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  /**
   * Step 2: the image is in storage → read it, ask the AI, create a PENDING log for the
   * partner to confirm. AI failure / not recognized = nothing is created.
   */
  async submitFromPhoto(couple: CoupleDoc, userId: string, imageKey: string): Promise<WaterSubmitResult> {
    assertOwnKey(couple._id, imageKey);

    let image;
    try {
      image = await getStorage().getObject(imageKey);
    } catch (err) {
      logger.warn('Image not found in storage', {
        coupleId: couple._id.toString(),
        imageKey,
        message: (err as Error).message,
      });
      throw Errors.notFound('Không tìm thấy ảnh đã tải lên. Hãy thử lại.');
    }
    if (image.size > env.s3.maxUploadBytes) {
      await getStorage().deleteObject(imageKey).catch(() => undefined);
      throw Errors.badRequest('Ảnh vượt kích thước cho phép');
    }

    let result;
    try {
      result = await getVision().analyze({ imageBuffer: image.body, mimeType: image.mimeType });
    } catch (err) {
      const msg = err instanceof WaterVisionError ? err.message : (err as Error).message;
      logger.error('Water vision failed', { coupleId: couple._id.toString(), userId, message: msg });
      throw new AppError(422, 'AI_UNAVAILABLE', 'AI đang bận hoặc lỗi. Thử lại hoặc nhập thủ công.', {
        manualFallback: true,
      });
    }
    if (!result.recognized || result.amountMl <= 0) {
      throw new AppError(
        422,
        'AI_NOT_RECOGNIZED',
        'AI không nhận ra ly/chai nước trong ảnh. Chụp lại hoặc nhập thủ công.',
        { manualFallback: true },
      );
    }

    return submit(couple, userId, result.amountMl, 'ai', imageKey, result.raw ?? null);
  },

  /** Manual entries also need the partner's approval — otherwise they would bypass the check. */
  async submitManual(couple: CoupleDoc, userId: string, amountMl: number, imageKey?: string): Promise<WaterSubmitResult> {
    if (!couple.memberIds.some((id) => id.toString() === userId)) throw Errors.forbidden('Bạn không thuộc couple này');
    if (!Number.isSafeInteger(amountMl) || amountMl < 10 || amountMl > MAX_MANUAL_ML) throw Errors.badRequest('Lượng nước phải từ 10 đến 3.000 ml');
    if (imageKey !== undefined) await validateManualProof(couple, userId, imageKey);
    return submit(couple, userId, amountMl, 'manual', imageKey ?? null, null);
  },

  /**
   * Partner approves → the ml is added to the submitter's total for the day the water was
   * logged (even if approved after midnight). Reject by the partner = rejected; reject by
   * the submitter = withdraw. The submitter can never approve their own log.
   */
  async review(
    couple: CoupleDoc,
    reviewerId: string,
    logId: string,
    decision: 'approve' | 'reject',
  ): Promise<WaterReviewResult> {
    const log = await waterRepository.findLog(couple._id, logId);
    if (!log) throw Errors.notFound('Bản ghi nước không tồn tại');
    if (statusOf(log) !== 'pending') throw Errors.conflict('Bản ghi này đã được xử lý');

    const isSubmitter = log.userId.toString() === reviewerId;
    if (decision === 'approve' && isSubmitter) {
      throw Errors.forbidden('Bạn không thể tự xác nhận lượng nước của mình');
    }

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = await waterRepository.review(couple._id, log._id, status, new Types.ObjectId(reviewerId));
    if (!updated) throw Errors.conflict('Bản ghi này đã được xử lý');

    await realtimeAudience.couple(couple._id, ['water']);
    const settings = await coupleSettingsRepository.getOrCreate(couple._id);
    let totalMl: number;
    let goalMet: boolean;
    if (status === 'approved') {
      const daily = await waterRepository.addToDaily(
        couple._id,
        updated.userId,
        updated.localDate,
        updated.amountMl,
        settings.waterGoalMl,
      );
      await realtimeAudience.couple(couple._id, ['water']);
      await questService.refresh(couple, 'drink_water', updated.localDate);
      totalMl = daily.totalMl;
      goalMet = daily.goalMet;
    } else {
      const daily = await waterRepository.getDaily(couple._id, updated.userId, updated.localDate);
      totalMl = daily?.totalMl ?? 0;
      goalMet = daily?.goalMet ?? false;
    }

    logger.info(
      status === 'approved'
        ? 'Water approved by partner'
        : isSubmitter
          ? 'Water submission withdrawn'
          : 'Water rejected by partner',
      {
        coupleId: couple._id.toString(),
        userId: reviewerId,
        logId,
        submitterId: updated.userId.toString(),
        amountMl: updated.amountMl,
      },
    );
    return { logId, status, amountMl: updated.amountMl, totalMl, goalMl: settings.waterGoalMl, goalMet };
  },

  /** Short-lived view URL; only for logs of the caller's couple (the partner needs it to review). */
  async imageUrl(couple: CoupleDoc, logId: string) {
    const log = await waterRepository.findLog(couple._id, logId);
    if (!log || !log.imageKey) throw Errors.notFound('Không có ảnh cho bản ghi này');
    if (log.source === 'manual') assertProofKey(couple._id, log.userId.toString(), log.imageKey);
    else assertOwnKey(couple._id, log.imageKey);
    return getStorage().getDownloadUrl(log.imageKey);
  },
};
