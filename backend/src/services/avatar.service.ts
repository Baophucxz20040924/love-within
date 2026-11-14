import { randomUUID } from 'node:crypto';
import { getStorage } from '../integrations/index.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { avatarUrlOf } from './profile.service.js';

/** The phone makes a 512×512 JPEG (~40–80 KB); 1 MB leaves room for PNG/WebP. */
export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Outside couples/ and friends/: one photo serves both spaces. IAM must allow avatars/*. */
const prefixOf = (userId: string) => `avatars/${userId}/`;

async function deleteQuietly(key: string): Promise<void> {
  await getStorage()
    .deleteObject(key)
    .catch((err: Error) => logger.warn('Could not delete old avatar', { key, message: err.message }));
}

/** Profile photos (plan/OPERATIONS.md, N1). */
export const avatarService = {
  async createUploadUrl(userId: string, mimeType: string, sizeBytes: number) {
    const ext = AVATAR_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > AVATAR_MAX_BYTES) throw Errors.badRequest('Ảnh đại diện phải ≤ 1 MB');
    const imageKey = `${prefixOf(userId)}${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: AVATAR_MAX_BYTES };
  },

  /** Use an uploaded photo: it must be under the caller's own prefix and really exist. The old photo is deleted. */
  async set(userId: string, key: string): Promise<{ avatarUrl: string | null }> {
    if (!key.startsWith(prefixOf(userId)) || key.includes('..')) {
      logger.warn('Rejected foreign avatar key', { userId, key });
      throw Errors.forbidden('Ảnh không thuộc tài khoản của bạn');
    }
    const head = await getStorage().headObject(key);
    if (!head) throw Errors.badRequest('Ảnh chưa tải lên xong. Thử lại nhé.');
    if (head.size > AVATAR_MAX_BYTES) throw Errors.badRequest('Ảnh đại diện phải ≤ 1 MB');
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');
    await userRepository.setAvatarKey(user._id, key);
    if (user.avatarKey && user.avatarKey !== key) await deleteQuietly(user.avatarKey);
    logger.info('Avatar updated', { userId });
    return { avatarUrl: await avatarUrlOf(key) };
  },

  async remove(userId: string): Promise<{ avatarUrl: null }> {
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');
    if (user.avatarKey) {
      await userRepository.setAvatarKey(user._id, null);
      await deleteQuietly(user.avatarKey);
      logger.info('Avatar removed', { userId });
    }
    return { avatarUrl: null };
  },
};
