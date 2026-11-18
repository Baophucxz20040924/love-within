import { apiRequest } from '../../lib/apiClient';
import { compressImage } from '../../lib/image';
import { preparePostMedia } from '../stories/postMedia';
import { putPostMedia } from '../stories/uploadPostMedia';
import type {
  PendingWater,
  Proposal,
  UploadUrlResult,
  WaterReviewResult,
  WaterSubmitResult,
  WaterToday,
} from '../../lib/types';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const waterApi = {
  today: () => apiRequest<WaterToday>('/water/today'),
  pending: () => apiRequest<PendingWater[]>('/water/pending'),
  approve: (id: string) => apiRequest<WaterReviewResult>(`/water/logs/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => apiRequest<WaterReviewResult>(`/water/logs/${id}/reject`, { method: 'POST' }),
  proposeGoal: (goalMl: number) =>
    apiRequest<Proposal>('/water/goal/propose', { method: 'POST', body: { goalMl } }),
  uploadUrl: (mimeType: string, sizeBytes: number, purpose: 'ai' | 'manual_proof' = 'ai') =>
    apiRequest<UploadUrlResult>('/water/upload-url', { method: 'POST', body: { mimeType, sizeBytes, purpose } }),
  photo: (imageKey: string) =>
    apiRequest<WaterSubmitResult>('/water/photo', { method: 'POST', body: { imageKey } }),
  manual: (amountMl: number, imageKey?: string) =>
    apiRequest<WaterSubmitResult>('/water/manual', { method: 'POST', body: { amountMl, ...(imageKey ? { imageKey } : {}) } }),
  imageUrl: (logId: string) => apiRequest<{ url: string; expiresIn: number }>(`/water/logs/${logId}/image-url`),
};

/** Manual evidence always uses decoded/re-encoded JPEG bytes; never compressImage's original fallback. */
export async function prepareWaterProof(file: File, signal: AbortSignal): Promise<Blob> {
  if (!file.type.startsWith('image/') && !(!file.type && /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(file.name))) {
    throw new Error('Chỉ chọn một ảnh minh chứng, không chọn video.');
  }
  const prepared = await preparePostMedia(file, signal);
  if (prepared.mediaType !== 'image' || prepared.mimeType !== 'image/jpeg' || prepared.blob === file) {
    throw new Error('Không xử lý được ảnh minh chứng. Hãy chọn ảnh JPEG/PNG khác.');
  }
  return prepared.blob;
}

export async function uploadWaterProof(blob: Blob, onProgress: (percent: number) => void, assertActive: () => void): Promise<string> {
  assertActive();
  if (blob.type !== 'image/jpeg' || !blob.size || blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh minh chứng phải là JPEG đã xử lý, tối đa 5 MB.');
  const signed = await waterApi.uploadUrl(blob.type, blob.size, 'manual_proof');
  assertActive();
  if (blob.size > signed.maxBytes) throw new Error('Ảnh vượt kích thước nơi lưu cho phép. Hãy chọn ảnh nhỏ hơn.');
  await putPostMedia(signed.uploadUrl, blob, percent => { try { assertActive(); onProgress(percent); } catch { /* obsolete view */ } });
  assertActive();
  return signed.imageKey;
}

export type PhotoStage = 'compress' | 'upload' | 'analyze';

/**
 * Full photo flow: shrink on the phone → presigned URL → PUT straight to storage → AI estimate.
 * The VPS never receives the image bytes. The result is PENDING until the partner approves.
 */
export async function uploadAndAnalyze(file: File, onStage?: (s: PhotoStage) => void): Promise<WaterSubmitResult> {
  onStage?.('compress');
  const blob = await compressImage(file);
  const mimeType = blob.type || 'image/jpeg';
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB). Thử chụp lại nhé.');

  onStage?.('upload');
  const { uploadUrl, imageKey } = await waterApi.uploadUrl(mimeType, blob.size);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');

  onStage?.('analyze');
  return waterApi.photo(imageKey);
}

export const WATER_KEY = ['water', 'today'] as const;
export const WATER_PENDING_KEY = ['water', 'pending'] as const;
export const waterImageKey = (logId: string) => ['water', 'image', logId] as const;
