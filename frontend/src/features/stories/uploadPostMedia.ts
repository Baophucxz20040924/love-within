import type { StoryVideoInput, UploadUrlResult, VideoUploadUrlResult } from '../../lib/types';
import type { LocalMedia } from './postMedia';

export interface UploadedPostMedia {
  photos: { key: string; width: number; height: number }[];
  videos: StoryVideoInput[];
}

type UploadedItem = { key: string; width: number; height: number; mimeType?: StoryVideoInput['mimeType'] };

/** Storage URLs are bearer capabilities: never forward the API's Authorization header. */
export function putPostMedia(url: string, blob: Blob, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = 10 * 60_000;
    xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error('Tải tệp lên thất bại. Hãy thử lại.'));
    xhr.onerror = () => reject(new Error('Không kết nối được nơi lưu tệp. Kiểm tra mạng rồi thử lại nhé.'));
    xhr.ontimeout = () => reject(new Error('Tải tệp quá lâu. Hãy thử lại khi mạng ổn định hơn.'));
    xhr.onabort = () => reject(new Error('Đã hủy tải tệp.'));
    xhr.send(blob);
  });
}

/** Prepared bytes are uploaded once, then reused if saving the post needs to be retried. */
export async function uploadPostMedia(
  media: LocalMedia[],
  cache: Map<string, UploadedItem>,
  urls: {
    uploadUrl: (mimeType: string, sizeBytes: number) => Promise<UploadUrlResult>;
    videoUploadUrl: (mimeType: string, sizeBytes: number) => Promise<VideoUploadUrlResult>;
  },
  onStatus: (status: string) => void,
  assertActive: () => void = () => {},
): Promise<UploadedPostMedia> {
  assertActive();
  const out: UploadedPostMedia = { photos: [], videos: [] };
  const total = media.filter((item) => item.kind === 'new').length;
  let n = 0;
  for (const item of media) {
    assertActive();
    let uploaded: UploadedItem;
    if (item.kind === 'existing') {
      uploaded = { key: item.key, width: item.width, height: item.height,
        ...(item.mediaType === 'video' ? { mimeType: item.mimeType as StoryVideoInput['mimeType'] } : {}) };
    } else {
      if (item.status !== 'ready' || !item.blob) throw new Error('Có tệp chưa xử lý xong. Hãy kiểm tra lại.');
      n += 1;
      const label = item.mediaType === 'video' ? 'video' : 'ảnh';
      const cached = cache.get(item.id);
      if (cached) uploaded = cached;
      else {
        onStatus(`Đang tải ${label} ${n}/${total}…`);
        const signed = item.mediaType === 'video'
          ? await urls.videoUploadUrl(item.mimeType, item.blob.size)
          : await urls.uploadUrl(item.mimeType, item.blob.size);
        assertActive();
        if (item.blob.size > signed.maxBytes) throw new Error('Tệp vượt kích thước nơi lưu cho phép. Hãy chọn tệp nhỏ hơn.');
        await putPostMedia(signed.uploadUrl, item.blob, (percent) => {
          try { assertActive(); } catch { return; }
          onStatus(`Đang tải ${label} ${n}/${total}… ${percent}%`);
        });
        assertActive();
        uploaded = { key: 'videoKey' in signed ? signed.videoKey : signed.imageKey,
          width: item.width, height: item.height,
          ...(item.mediaType === 'video' ? { mimeType: item.mimeType as StoryVideoInput['mimeType'] } : {}) };
        cache.set(item.id, uploaded);
      }
    }
    if (item.mediaType === 'video') {
      if (uploaded.mimeType !== 'video/mp4' && uploaded.mimeType !== 'video/webm' && uploaded.mimeType !== 'video/quicktime') throw new Error('Định dạng video chưa được hỗ trợ.');
      out.videos.push({ key: uploaded.key, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType });
    } else out.photos.push({ key: uploaded.key, width: uploaded.width, height: uploaded.height });
  }
  return out;
}

export type PostMediaUploadCache = Map<string, UploadedItem>;
