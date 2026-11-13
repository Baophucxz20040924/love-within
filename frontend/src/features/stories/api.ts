import { apiRequest } from '../../lib/apiClient';
import { compressImageWithSize } from '../../lib/image';
import type { Story, StoryComment, StoryContentInput, StoryPage, StoryUnread, UploadUrlResult } from '../../lib/types';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
// Story ids come from the page URL (/stories/:id), so encode them before building API paths.
const enc = encodeURIComponent;

export const storiesApi = {
  feed: (cursor?: string) => apiRequest<StoryPage>(`/stories?limit=10${cursor ? `&cursor=${enc(cursor)}` : ''}`),
  get: (id: string) => apiRequest<Story>(`/stories/${enc(id)}`),
  create: (input: StoryContentInput) => apiRequest<Story>('/stories', { method: 'POST', body: input }),
  update: (id: string, input: StoryContentInput) => apiRequest<Story>(`/stories/${enc(id)}`, { method: 'PATCH', body: input }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/stories/${enc(id)}`, { method: 'DELETE' }),
  react: (id: string, type: string) => apiRequest<Story>(`/stories/${enc(id)}/reaction`, { method: 'PUT', body: { type } }),
  unreact: (id: string) => apiRequest<Story>(`/stories/${enc(id)}/reaction`, { method: 'DELETE' }),
  comments: (id: string) => apiRequest<StoryComment[]>(`/stories/${enc(id)}/comments`),
  addComment: (id: string, body: string) =>
    apiRequest<StoryComment>(`/stories/${enc(id)}/comments`, { method: 'POST', body: { body } }),
  deleteComment: (id: string, commentId: string) =>
    apiRequest<{ ok: true }>(`/stories/${enc(id)}/comments/${enc(commentId)}`, { method: 'DELETE' }),
  unread: () => apiRequest<StoryUnread>('/stories/unread-count'),
  seen: () => apiRequest<{ previousSeenAt: string | null }>('/stories/seen', { method: 'POST' }),
  onThisDay: () => apiRequest<Story[]>('/stories/on-this-day'),
  uploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/stories/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
};

/** Compress on the phone (≤ 1600 px JPEG, EXIF/GPS stripped) → presigned URL → PUT straight to storage. */
export async function uploadStoryPhoto(file: File): Promise<{ key: string; width: number; height: number }> {
  const { blob, width, height } = await compressImageWithSize(file, 1600, 0.85);
  const mimeType = blob.type || 'image/jpeg';
  if (!ALLOWED.includes(mimeType)) throw new Error('Định dạng ảnh này chưa được hỗ trợ. Hãy chọn ảnh JPEG/PNG.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB).');
  const { uploadUrl, imageKey } = await storiesApi.uploadUrl(mimeType, blob.size);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
  // Unknown size (browser could not decode) → assume 4:3 for layout.
  return { key: imageKey, width: width || 1600, height: height || 1200 };
}

export const STORY_FEED_KEY = ['stories', 'feed'] as const;
export const STORY_UNREAD_KEY = ['stories', 'unread'] as const;
export const STORY_OTD_KEY = ['stories', 'on-this-day'] as const;
export const storyKey = (id: string) => ['stories', 'detail', id] as const;
export const storyCommentsKey = (id: string) => ['stories', 'comments', id] as const;
