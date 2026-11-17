export const POST_MEDIA_ACCEPT = 'image/*,video/mp4,video/webm,video/quicktime,.heic,.heif,.mp4,.webm,.mov';
const VIDEO_PREFIX_BYTES = 64 * 1024;
export const MAX_POST_MEDIA = 10;
export const MAX_POST_VIDEOS = 1;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_INPUT_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = 5 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;

export type ExistingMedia = {
  id: string;
  kind: 'existing';
  mediaType: 'image' | 'video';
  key: string;
  url: string;
  width: number;
  height: number;
  mimeType?: string;
};

export type PostMediaFile = {
  id: string;
  kind: 'new';
  mediaType: 'image' | 'video';
  file: File;
  status: 'processing' | 'ready' | 'error';
  error?: string;
  width: number;
  height: number;
  mimeType: string;
  blob?: Blob;
};

export type LocalMedia = ExistingMedia | PostMediaFile;
export type PreparedPostMedia = {
  mediaType: 'image' | 'video';
  mimeType: string;
  blob: Blob;
  width: number;
  height: number;
};

type DecodedImage = { source: CanvasImageSource; width: number; height: number; close(): void };
const imageError = () => new Error('Không đọc được ảnh này trên trình duyệt hiện tại. Hãy đổi sang JPEG/PNG rồi chọn lại (HEIC chỉ hỗ trợ khi trình duyệt đọc được).');
const videoError = () => new Error('Không đọc được khung hình video. Khả năng phát MOV, MP4 và WebM phụ thuộc codec và trình duyệt; hãy thử MP4 H.264 hoặc WebM rồi chọn lại.');
const aborted = () => new DOMException('Đã hủy xử lý tệp.', 'AbortError');
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw aborted(); }
function validDimensions(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** An uncancellable browser decode may finish after cancellation; release its late bitmap too. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error('Xử lý tệp quá lâu. Hãy chọn lại tệp nhỏ hơn hoặc đổi định dạng.')), DECODE_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) disposeLate?.(value); else finish(undefined, value);
    }, error => finish(error));
    if (signal.aborted) onAbort();
  });
}

const text = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
function signature(bytes: Uint8Array, totalSize: number): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (text(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(text(bytes, 0, 6))) return 'image/gif';
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (text(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (['II\x2a\0', 'MM\0\x2a'].includes(text(bytes, 0, 4))) return 'image/tiff';
  if (text(bytes, 0, 4) === '\0\0\x01\0') return 'image/x-icon';
  // Match the server's bounded BMFF box policy, including optional padding and extended sizes.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const type = text(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      const wideSize = view.getBigUint64(offset + 8);
      if (wideSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(wideSize);
      headerSize = 16;
    }
    if (size < headerSize || offset + size > totalSize || offset + size > bytes.length) break;
    if (type === 'ftyp') {
      const payload = size - headerSize;
      if (payload < 8 || (payload - 8) % 4 !== 0) break;
      const major = text(bytes, offset + headerSize, 4);
      const compatible: string[] = [];
      for (let i = offset + headerSize + 8; i < offset + size; i += 4) compatible.push(text(bytes, i, 4));
      const brands = [major, ...compatible];
      if (brands.some(brand => /^(avif|avis)$/.test(brand))) return 'image/avif';
      if (brands.some(brand => /^(hei[cxms]|hev[cxms]|mif1|msf1)$/.test(brand))) return 'image/heic';
      if (major === 'qt  ') return 'video/quicktime';
      if (!compatible.includes('qt  ') && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(major)) return 'video/mp4';
      break;
    }
    if (!['free', 'skip', 'wide'].includes(type)) break;
    offset += size;
  }
  if (text(bytes, 0, 4) === '\x1a\x45\xdf\xa3') {
    // EBML alone also identifies Matroska. Require its bounded DocType field to say WebM.
    for (let i = 4; i + 7 <= bytes.length; i++) {
      if (bytes[i] === 0x42 && bytes[i + 1] === 0x82 && bytes[i + 2] === 0x84 && text(bytes, i + 3, 4) === 'webm') return 'video/webm';
    }
  }
  return undefined;
}

const imageExtensions: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', ico: 'image/x-icon',
};

async function classify(file: File, signal: AbortSignal): Promise<{ mediaType: 'image' | 'video'; mimeType: string }> {
  if (!file.size) throw new Error('Tệp trống. Hãy chọn ảnh hoặc video khác.');
  const mime = file.type.toLowerCase().split(';')[0].trim();
  const missingMime = !mime || mime === 'application/octet-stream';
  const detected = signature(new Uint8Array(await waitFor(file.slice(0, VIDEO_PREFIX_BYTES).arrayBuffer(), signal)), file.size);
  checkAbort(signal);
  if (mime === 'video/mp4' || mime === 'video/webm' || mime === 'video/quicktime' || (missingMime && detected?.startsWith('video/'))) {
    if (!detected?.startsWith('video/') || (!missingMime && detected !== mime)) {
      throw new Error('Định dạng bên trong tệp không khớp MP4/WebM/MOV. Hãy đổi sang MP4 H.264 hoặc WebM rồi chọn lại.');
    }
    if (file.size > MAX_VIDEO_BYTES) throw new Error('Video vượt quá 50 MiB. Hãy chọn video nhỏ hơn hoặc nén video trước.');
    return { mediaType: 'video', mimeType: detected };
  }
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('image/') || (missingMime && (detected?.startsWith('image/') || imageExtensions[extension]))) {
    if (detected?.startsWith('video/')) throw new Error('Tệp được ghi là ảnh nhưng chứa video. Hãy chọn lại tệp MP4/WebM/MOV đúng định dạng.');
    if (file.size > MAX_IMAGE_INPUT_BYTES) throw new Error('Ảnh vượt quá 30 MiB. Hãy thu nhỏ ảnh hoặc chọn ảnh khác.');
    return { mediaType: 'image', mimeType: detected ?? (missingMime ? imageExtensions[extension] : mime) };
  }
  throw new Error('Tệp chưa được hỗ trợ. Hãy chọn ảnh JPEG/PNG hoặc video MP4, WebM hay MOV.');
}

function decodeImageElement(blob: Blob, signal: AbortSignal): Promise<DecodedImage> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    let settled = false;
    const close = () => { image.removeAttribute('src'); URL.revokeObjectURL(url); };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      image.onload = null;
      image.onerror = null;
      if (error) { close(); reject(error); }
      else resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, close });
    };
    const onAbort = () => finish(aborted());
    const timer = setTimeout(() => finish(imageError()), DECODE_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    image.onerror = () => finish(imageError());
    image.onload = () => {
      // Some browsers load a container without being able to decode its pixels.
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      decoded.then(() => finish(validDimensions(image.naturalWidth, image.naturalHeight) ? undefined : imageError()), () => finish(imageError()));
    };
    image.src = url;
    if (signal.aborted) onAbort();
  });
}

async function decodeImage(blob: Blob, signal: AbortSignal): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await waitFor(createImageBitmap(blob, { imageOrientation: 'from-image' }), signal, late => late.close());
      if (!validDimensions(bitmap.width, bitmap.height)) { bitmap.close(); throw imageError(); }
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { checkAbort(signal); }
  }
  return decodeImageElement(blob, signal);
}

async function prepareImage(blob: Blob, signal: AbortSignal): Promise<PreparedPostMedia> {
  const decoded = await decodeImage(blob, signal);
  let canvas: HTMLCanvasElement | undefined;
  try {
    checkAbort(signal);
    const scale = Math.min(1, 1600 / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Trình duyệt không xử lý được ảnh. Hãy thử lại hoặc dùng trình duyệt khác.');
    context.drawImage(decoded.source, 0, 0, width, height);
    for (const quality of [0.82, 0.65, 0.45]) {
      const output = await waitFor(new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/jpeg', quality)), signal);
      checkAbort(signal);
      if (!output?.size || output.type !== 'image/jpeg') throw new Error('Không tạo được ảnh JPEG. Hãy đổi sang JPEG/PNG rồi chọn lại.');
      if (output.size <= MAX_IMAGE_OUTPUT_BYTES) return { mediaType: 'image', mimeType: 'image/jpeg', blob: output, width, height };
    }
    throw new Error('Ảnh sau xử lý vẫn vượt quá 5 MiB. Hãy thu nhỏ ảnh rồi chọn lại.');
  } finally {
    decoded.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

function prepareVideo(blob: Blob, mimeType: string, signal: AbortSignal): Promise<PreparedPostMedia> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      const width = video.videoWidth;
      const height = video.videoHeight;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve({ mediaType: 'video', mimeType, blob, width, height });
    };
    const onAbort = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error('Không đọc được khung hình video trong 30 giây. Hãy chọn lại hoặc đổi sang MP4 H.264/WebM.')), DECODE_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;
    video.onloadeddata = () => finish(video.readyState >= 2 && validDimensions(video.videoWidth, video.videoHeight) ? undefined : videoError());
    video.onerror = () => finish(videoError());
    video.src = url;
    video.load();
    if (signal.aborted) onAbort();
  });
}

/** Strict post-only preparation. No original-file/fake-dimension fallback and no display URLs. */
export async function preparePostMedia(file: File, signal: AbortSignal): Promise<PreparedPostMedia> {
  checkAbort(signal);
  const { mediaType, mimeType } = await classify(file, signal);
  checkAbort(signal);
  // Give a missing/octet-stream MIME the detected type for native image/video decoders.
  const blob = file.type === mimeType ? file : file.slice(0, file.size, mimeType);
  return mediaType === 'video' ? prepareVideo(blob, mimeType, signal) : prepareImage(blob, signal);
}
