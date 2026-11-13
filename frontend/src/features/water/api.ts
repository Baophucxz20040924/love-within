import { apiRequest } from '../../lib/apiClient';
import { compressImage } from '../../lib/image';
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
  uploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/water/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
  photo: (imageKey: string) =>
    apiRequest<WaterSubmitResult>('/water/photo', { method: 'POST', body: { imageKey } }),
  manual: (amountMl: number) =>
    apiRequest<WaterSubmitResult>('/water/manual', { method: 'POST', body: { amountMl } }),
  imageUrl: (logId: string) => apiRequest<{ url: string; expiresIn: number }>(`/water/logs/${logId}/image-url`),
};

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
