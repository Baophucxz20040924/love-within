/**
 * Shrink a camera photo before upload: longest side ≤ maxSide, re-encoded as JPEG.
 * - Phone photos (3–10 MB) become ~150–500 KB → faster upload on mobile data, lower S3 + AI cost.
 * - Re-encoding through a canvas drops EXIF metadata, including GPS location.
 * Falls back to the original file (width/height 0) if the browser cannot decode it (e.g. HEIC outside Safari).
 */
export async function compressImageWithSize(
  file: Blob,
  maxSide = 1280,
  quality = 0.82,
): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { blob: file, width: 0, height: 0 };
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { blob: file, width: 0, height: 0 };
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  // Release the pixel buffer right away: iOS Safari caps total canvas memory, which matters when uploading 10 photos.
  canvas.width = 0;
  canvas.height = 0;
  return blob ? { blob, width, height } : { blob: file, width: 0, height: 0 };
}

export async function compressImage(file: Blob, maxSide = 1280, quality = 0.82): Promise<Blob> {
  return (await compressImageWithSize(file, maxSide, quality)).blob;
}

/**
 * Profile photo: center square crop, at most size×size, JPEG. Re-encoding through a canvas drops EXIF/GPS.
 * Throws a Vietnamese message when the browser cannot read the file (e.g. HEIC outside Safari).
 */
export async function cropSquare(file: Blob, size = 512, quality = 0.85): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Không đọc được ảnh này. Hãy chọn ảnh JPEG hoặc PNG.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.max(1, Math.min(size, side));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Không xử lý được ảnh này.');
  }
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('Không xử lý được ảnh này.');
  return blob;
}
