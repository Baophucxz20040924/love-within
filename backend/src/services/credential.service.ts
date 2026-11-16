import bcrypt from 'bcryptjs';
import type { UserDoc } from '../models/User.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';

export const ADMIN_EMAIL = 'admin@phucxz.com';
export const BCRYPT_ROUNDS = 11;
export const TEMPORARY_PASSWORD_TTL_MS = 24 * 60 * 60_000;
export const LIMITED_SESSION_TTL_SECONDS = 15 * 60;
export type CredentialSnapshot = Pick<UserDoc, '_id' | 'email' | 'passwordHash' | 'role' | 'credentialVersion' | 'mustChangePassword' | 'temporaryPasswordExpiresAt'>;

export function normalizeEmail(email: string): string { return email.toLowerCase().trim(); }

/** Only an absent legacy version defaults to zero; malformed persisted values fail closed. */
export function credentialVersionOf(user: { credentialVersion?: number }): number {
  const version = user.credentialVersion === undefined ? 0 : user.credentialVersion;
  if (!Number.isSafeInteger(version) || version < 0) throw Errors.unauthorized('Phiên đăng nhập không còn hợp lệ');
  return version;
}

export function isAppAccount(user: { role?: string; email: string }): boolean {
  return (user.role === undefined || user.role === 'user') && normalizeEmail(user.email) !== ADMIN_EMAIL;
}

export function isAdminAccount(user: { role?: string; email: string }): boolean {
  return user.role === 'admin' && normalizeEmail(user.email) === ADMIN_EMAIL;
}

/** bcrypt ignores bytes after 72; reject them rather than silently accepting equivalent passwords. */
export function assertNewPassword(password: string, confirmation: string): void {
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72 || password.includes('\0')) {
    throw Errors.badRequest('Mật khẩu cần ít nhất 8 ký tự, tối đa 72 byte và không chứa ký tự rỗng');
  }
  if (password !== confirmation) throw Errors.badRequest('Mật khẩu xác nhận không khớp');
}

let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= bcrypt.hash('look-within-timing-equalizer', BCRYPT_ROUNDS));

/** Always perform a bcrypt comparison, including unknown accounts. */
export async function compareCredential(password: string, user: CredentialSnapshot | null): Promise<boolean> {
  const match = await bcrypt.compare(password, user?.passwordHash ?? await getDummyHash());
  return !!user && match;
}

function assertVersion(user: CredentialSnapshot | null, version: number): asserts user is CredentialSnapshot {
  if (!user || !Number.isSafeInteger(version) || version < 0 || credentialVersionOf(user) !== version) {
    throw Errors.unauthorized('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại');
  }
}

export const credentialService = {
  /** Narrow DB read suitable for every request, SSE delivery and push revalidation. */
  getCurrentCredential(userId: string): Promise<CredentialSnapshot | null> {
    return userRepository.findCredentialsById(userId);
  },

  async assertApp(userId: string, version: number): Promise<CredentialSnapshot> {
    const user = await this.getCurrentCredential(userId);
    assertVersion(user, version);
    if (!isAppAccount(user) || user.mustChangePassword || user.temporaryPasswordExpiresAt != null) {
      throw Errors.unauthorized('Vui lòng đăng nhập và hoàn tất đổi mật khẩu');
    }
    return user;
  },

  async assertAdmin(userId: string, version: number): Promise<CredentialSnapshot> {
    const user = await this.getCurrentCredential(userId);
    assertVersion(user, version);
    if (!isAdminAccount(user) || user.mustChangePassword || user.temporaryPasswordExpiresAt != null) {
      throw Errors.unauthorized('Phiên quản trị không hợp lệ');
    }
    return user;
  },

  async assertPasswordChange(userId: string, version: number): Promise<CredentialSnapshot> {
    const user = await this.getCurrentCredential(userId);
    assertVersion(user, version);
    if (!isAppAccount(user) || user.mustChangePassword !== true ||
        !(user.temporaryPasswordExpiresAt instanceof Date) || user.temporaryPasswordExpiresAt.getTime() <= Date.now()) {
      throw Errors.unauthorized('Quyền đổi mật khẩu đã hết hạn, vui lòng đăng nhập lại');
    }
    return user;
  },
};
