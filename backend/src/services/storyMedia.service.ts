import { randomUUID } from 'node:crypto';
import { getStorage } from '../integrations/index.js';
import { MAX_STORY_ATTACHMENTS, MAX_STORY_VIDEOS, MAX_STORY_VIDEO_BYTES, type StoryPhoto, type StoryVideo } from '../models/Story.js';
import { Errors } from '../utils/errors.js';

export const STORY_VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' } as const;
/** A small bounded read for container plausibility only, NOT codec/duration or malware verification. */
export const STORY_VIDEO_PREFIX_BYTES = 64 * 1024;

export function normalizeStoryVideos(photos: StoryPhoto[], videos: StoryVideo[] = []): StoryVideo[] {
  if (videos.length > MAX_STORY_VIDEOS) throw Errors.badRequest(`Tối đa ${MAX_STORY_VIDEOS} video mỗi bài viết`);
  if (photos.length + videos.length > MAX_STORY_ATTACHMENTS) {
    throw Errors.badRequest(`Tối đa ${MAX_STORY_ATTACHMENTS} ảnh và video mỗi bài viết`);
  }
  return videos.map(({ key, mimeType, width, height }) => {
    if (!Object.hasOwn(STORY_VIDEO_TYPES, mimeType) || typeof key !== 'string' || key.length > 300 ||
        !Number.isInteger(width) || width < 1 || width > 20_000 || !Number.isInteger(height) || height < 1 || height > 20_000) {
      throw Errors.badRequest('Thông tin video không hợp lệ');
    }
    return { key, mimeType, width, height };
  });
}

export function sameStoryVideos(a: StoryVideo[] = [], b: StoryVideo[] = []): boolean {
  return a.length === b.length && a.every((v, i) =>
    v.key === b[i].key && v.mimeType === b[i].mimeType && v.width === b[i].width && v.height === b[i].height);
}

/** Separate sibling prefix: image-only validators must never accept a video key. */
export function storyVideoPrefix(scope: 'friends' | 'couples', id: string): string {
  return `${scope}/${id}/story-videos/`;
}

export async function createStoryVideoUploadUrl(prefix: string, month: string, mimeType: string, sizeBytes: number) {
  if (!Object.hasOwn(STORY_VIDEO_TYPES, mimeType)) throw Errors.badRequest('Chỉ chấp nhận video MP4/WebM');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_STORY_VIDEO_BYTES) {
    throw Errors.badRequest('Video phải lớn hơn 0 và không quá 50 MiB');
  }
  const ext = STORY_VIDEO_TYPES[mimeType as StoryVideo['mimeType']];
  const videoKey = `${prefix}${month}/${randomUUID()}.${ext}`;
  const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: videoKey, mimeType, sizeBytes });
  return { uploadUrl, videoKey, expiresIn, maxBytes: MAX_STORY_VIDEO_BYTES };
}

function plausibleMp4(bytes: Buffer, totalSize: number): boolean {
  // An ftyp box near the start is conventional ISO-BMFF. Permit only padding boxes before it.
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const wideSize = bytes.readBigUInt64BE(offset + 8);
      if (wideSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(wideSize);
      headerSize = 16;
    }
    if (size < headerSize || offset + size > totalSize || offset + size > bytes.length) return false;
    if (type === 'ftyp') {
      const payload = size - headerSize;
      // major_brand + minor_version, followed by zero or more compatible brands.
      if (payload < 8 || (payload - 8) % 4 !== 0) return false;
      const majorBrand = bytes.toString('latin1', offset + headerSize, offset + headerSize + 4);
      // ISO-BMFF also carries HEIF/AVIF images and QuickTime MOV. An ftyp box alone is not MP4.
      // Require a known MP4 major brand; a compatible MP4 brand must not rescue a foreign major brand.
      if (!/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(majorBrand)) return false;
      for (let brandOffset = offset + headerSize + 8; brandOffset < offset + size; brandOffset += 4) {
        const compatible = bytes.toString('latin1', brandOffset, brandOffset + 4);
        if (/^(?:hei[cxms]|hev[cxms]|mif1|msf1|avif|avis|qt  )$/.test(compatible)) return false;
      }
      return true;
    }
    if (!['free', 'skip', 'wide'].includes(type)) return false;
    offset += size;
  }
  return false;
}

/** Read a finite EBML variable integer. IDs retain their marker; sizes remove it. */
function ebmlInteger(bytes: Buffer, offset: number, id: boolean): { value: number; length: number } | null {
  if (offset >= bytes.length || bytes[offset] === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (!(bytes[offset] & mask)) { mask >>= 1; length += 1; }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = id ? bytes[offset] : bytes[offset] & (mask - 1);
  let unknown = !id && value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[offset + i];
    unknown = unknown && bytes[offset + i] === 0xff;
  }
  return unknown || !Number.isSafeInteger(value) ? null : { value, length };
}

function plausibleWebm(bytes: Buffer): boolean {
  if (bytes.length < 5 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const headerSize = ebmlInteger(bytes, 4, false);
  if (!headerSize) return false;
  let offset = 4 + headerSize.length;
  const end = offset + headerSize.value;
  if (end > bytes.length) return false;
  let webm = false;
  while (offset < end) {
    const id = ebmlInteger(bytes, offset, true);
    if (!id) return false;
    offset += id.length;
    const size = ebmlInteger(bytes, offset, false);
    if (!size) return false;
    offset += size.length;
    if (offset + size.value > end) return false;
    if (id.value === 0x4282) {
      if (webm || size.value !== 4 || bytes.toString('latin1', offset, offset + size.value) !== 'webm') return false;
      webm = true;
    }
    offset += size.value;
  }
  return webm;
}

/** Recheck new keys AND changed descriptors; unchanged attached media need no extra storage reads. */
export async function validateStoryVideos(prefix: string, videos: StoryVideo[], attached: StoryVideo[] = []): Promise<void> {
  const seen = new Set<string>();
  for (const video of videos) {
    const suffix = video.key.startsWith(prefix) ? video.key.slice(prefix.length) : '';
    const ext = STORY_VIDEO_TYPES[video.mimeType];
    if (!/^\d{4}-(?:0[1-9]|1[0-2])\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.(?:mp4|webm)$/.test(suffix) ||
        !suffix.endsWith(`.${ext}`)) throw Errors.forbidden('Video không thuộc bài viết của bạn hoặc định dạng không hợp lệ');
    if (seen.has(video.key)) throw Errors.badRequest('Có video bị trùng');
    seen.add(video.key);
    if (attached.some((old) => sameStoryVideos([video], [old]))) continue;
    const storage = getStorage();
    const head = await storage.headObject(video.key);
    if (!head) throw Errors.badRequest('Có video chưa tải lên xong. Thử đăng lại nhé.');
    if (!Number.isSafeInteger(head.size) || head.size <= 0 || head.size > MAX_STORY_VIDEO_BYTES) {
      throw Errors.badRequest('Video phải lớn hơn 0 và không quá 50 MiB');
    }
    if (head.mimeType !== video.mimeType) throw Errors.badRequest('Định dạng video không khớp với tệp đã tải lên');
    // Required adapter capability: never fall back to downloading an entire video.
    const bytes = await storage.getObjectPrefix(video.key, STORY_VIDEO_PREFIX_BYTES);
    if (!Buffer.isBuffer(bytes) || bytes.length > STORY_VIDEO_PREFIX_BYTES || bytes.length > head.size ||
        !(video.mimeType === 'video/mp4' ? plausibleMp4(bytes, head.size) : plausibleWebm(bytes))) {
      throw Errors.badRequest('Tệp không có phần đầu video MP4/WebM hợp lệ');
    }
  }
}

/** Existing/shared photos retain compatibility; only newly attached objects need this HEAD check. */
export function validateStoryPhotoHead(head: { size: number; mimeType: string } | null, maxBytes: number): void {
  if (!head) throw Errors.badRequest('Có ảnh chưa tải lên xong. Thử đăng lại nhé.');
  if (!Number.isSafeInteger(head.size) || head.size <= 0 || head.size > maxBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép hoặc trống');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(head.mimeType)) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
}
