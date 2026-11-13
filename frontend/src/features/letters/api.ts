import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import { compressImageWithSize } from '../../lib/image';
import type { LetterInput, LetterList, LetterView, UploadUrlResult } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
// Letter ids come from the page URL (/letters/:id), so encode them before building API paths.
const enc = encodeURIComponent;

export const lettersApi = {
  list: () => apiRequest<LetterList>('/letters'),
  /** Recipient before the open time: 403 LETTER_SEALED (details.letter = the envelope only). */
  get: (id: string) => apiRequest<LetterView>(`/letters/${enc(id)}`),
  create: (input: LetterInput) => apiRequest<LetterView>('/letters', { method: 'POST', body: input }),
  update: (id: string, input: LetterInput) => apiRequest<LetterView>(`/letters/${enc(id)}`, { method: 'PATCH', body: input }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/letters/${enc(id)}`, { method: 'DELETE' }),
  open: (id: string) => apiRequest<LetterView>(`/letters/${enc(id)}/open`, { method: 'POST' }),
  uploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/letters/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
};

/** Same flow as story photos: compress on the phone (≤ 1600 px JPEG, EXIF/GPS stripped) → presigned URL → PUT to storage. */
export async function uploadLetterPhoto(file: File): Promise<{ key: string; width: number; height: number }> {
  const { blob, width, height } = await compressImageWithSize(file, 1600, 0.85);
  const mimeType = blob.type || 'image/jpeg';
  if (!ALLOWED.includes(mimeType)) throw new Error('Định dạng ảnh này chưa được hỗ trợ. Hãy chọn ảnh JPEG/PNG.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB).');
  const { uploadUrl, imageKey } = await lettersApi.uploadUrl(mimeType, blob.size);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
  return { key: imageKey, width: width || 1600, height: height || 1200 };
}

export const LETTERS_KEY = ['letters'] as const;
export const LETTER_LIST_KEY = ['letters', 'list'] as const;
export const letterKey = (id: string) => ['letters', 'detail', id] as const;

export const MAX_LETTER_TITLE = 80;
export const MAX_LETTER_BODY = 20_000;
export const MAX_LETTER_PHOTOS = 4;
export const MAX_LETTER_YEARS = 20;

/** After a change: reload the lists, the letter pages and the Home card. */
export async function refreshLetters(qc: QueryClient): Promise<void> {
  await Promise.all([qc.invalidateQueries({ queryKey: LETTERS_KEY }), qc.invalidateQueries({ queryKey: PULSE_KEY })]);
}
