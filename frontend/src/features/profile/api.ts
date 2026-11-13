import { apiRequest } from '../../lib/apiClient';
import type { UploadUrlResult } from '../../lib/types';

export const profileApi = {
  avatarUploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/me/avatar/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
  setAvatar: (key: string) => apiRequest<{ avatarUrl: string | null }>('/me/avatar', { method: 'PUT', body: { key } }),
  removeAvatar: () => apiRequest<{ avatarUrl: null }>('/me/avatar', { method: 'DELETE' }),
};

/** Square JPEG made on the phone → presigned URL → PUT straight to storage → use it as my photo. */
export async function uploadAvatar(photo: Blob): Promise<void> {
  const mimeType = photo.type || 'image/jpeg';
  const { uploadUrl, imageKey } = await profileApi.avatarUploadUrl(mimeType, photo.size);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: photo });
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
  await profileApi.setAvatar(imageKey);
}
