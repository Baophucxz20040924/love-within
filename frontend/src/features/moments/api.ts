import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import { compressImageWithSize } from '../../lib/image';
import type { MomentDay, MomentMonth, MomentSession, MomentStoryResult, MomentTarget, UploadUrlResult } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';
import { QUESTS_KEY } from '../quests/api';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const enc = encodeURIComponent;

export const MAX_MOMENT_CAPTION = 100;

export const momentsApi = {
  today: () => apiRequest<MomentDay>('/moments/today'),
  month: (month: string) => apiRequest<MomentMonth>(`/moments?month=${enc(month)}`),
  /** 409 MOMENT_NOT_YET before the prompt, MOMENT_ALREADY_POSTED after my post. */
  uploadUrl: (target: MomentTarget, mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/moments/upload-url', { method: 'POST', body: { ...target, mimeType, sizeBytes } }),
  post: (input: MomentTarget & { key: string; width: number; height: number; caption: string }) =>
    apiRequest<MomentDay>('/moments/today', { method: 'POST', body: input }),
  toStory: (target: MomentTarget) => apiRequest<MomentStoryResult>(`/moments/${enc(target.localDate)}/story`, { method: 'POST', body: { sessionId: target.sessionId } }),
};

/** Same flow as story photos: compress on the phone (≤ 1600 px JPEG, EXIF/GPS stripped) → presigned URL → PUT to storage. */
export async function uploadMomentPhoto(file: File, target: MomentTarget, assertCurrent: () => void): Promise<{ key: string; width: number; height: number }> {
  assertCurrent();
  const { blob, width, height } = await compressImageWithSize(file, 1600, 0.85);
  assertCurrent();
  const mimeType = blob.type || 'image/jpeg';
  if (!ALLOWED.includes(mimeType)) throw new Error('Định dạng ảnh này chưa được hỗ trợ. Hãy chụp lại hoặc chọn ảnh JPEG/PNG.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB).');
  const { uploadUrl, imageKey } = await momentsApi.uploadUrl(target, mimeType, blob.size);
  assertCurrent();
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  assertCurrent();
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
  // Unknown size (browser could not decode) → assume 3:4 portrait for layout.
  return { key: imageKey, width: width || 1200, height: height || 1600 };
}

export const MOMENTS_KEY = ['moments'] as const;
export const MOMENT_TODAY_KEY = ['moments', 'today'] as const;
export const momentMonthKey = (month: string) => ['moments', 'month', month] as const;

/** After a post: today, the calendar, the Home card and the quest. */
export async function refreshMoments(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: MOMENTS_KEY }),
    qc.invalidateQueries({ queryKey: PULSE_KEY }),
    qc.invalidateQueries({ queryKey: QUESTS_KEY }),
  ]);
}

/** "Muộn 25 phút", "Muộn 2 giờ" (whole hours); null when on time. */
export function lateText(lateMin: number): string | null {
  if (lateMin <= 0) return null;
  return lateMin < 60 ? `Muộn ${lateMin} phút` : `Muộn ${Math.floor(lateMin / 60)} giờ`;
}

/** Reward eligibility uses timestamps, never the rounded display-only lateMin. */
export function isMomentPhotoOnTime(session: Pick<MomentSession, 'promptAt' | 'rewardEndsAt'>, postedAt: string): boolean {
  const posted = Date.parse(postedAt);
  return posted >= Date.parse(session.promptAt) && posted < Date.parse(session.rewardEndsAt);
}

/** "07:42" left in the 30-minute reward window. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
