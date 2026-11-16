import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { realtimeService } from './realtime.service.js';
import { tokenService } from './token.service.js';
import {
  BCRYPT_ROUNDS, TEMPORARY_PASSWORD_TTL_MS, assertNewPassword, compareCredential, credentialService,
  credentialVersionOf, isAdminAccount, isAppAccount,
} from './credential.service.js';

export interface AdminIdentity { userId: string; credentialVersion: number }
export interface AdminUserView {
  id: string;
  displayName: string;
  email: string;
  credentialVersion: number;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

function audit(action: string, actorId: string | undefined, targetId: string | undefined, outcome: 'success' | 'failure'): void {
  // Static action names and identifiers only. logger attaches the timestamp; never include errors/input.
  logger.info('Credential administration', { action, ...(actorId ? { actorId } : {}), ...(targetId ? { targetId } : {}), outcome });
}

export const adminService = {
  async login(input: { email: string; password: string }): Promise<{ adminToken: string; expiresAt: string }> {
    const user = await userRepository.findByEmail(input.email);
    const version = user ? credentialVersionOf(user) : 0;
    const id = user?._id.toString();
    try {
      const match = await compareCredential(input.password, user);
      if (!user || !id || !match || !isAdminAccount(user)) throw Errors.unauthorized('Email hoặc mật khẩu không đúng');
      await credentialService.assertAdmin(id, version);
      const grant = tokenService.signAdmin(id, version);
      audit('admin.login', id, undefined, 'success');
      return { adminToken: grant.token, expiresAt: grant.expiresAt };
    } catch (error) {
      audit('admin.login', id, undefined, 'failure');
      throw error;
    }
  },

  async findUser(actor: AdminIdentity, email: string): Promise<{ user: AdminUserView | null }> {
    await credentialService.assertAdmin(actor.userId, actor.credentialVersion);
    const user = await userRepository.findRecoveryByEmail(email);
    if (!user || !isAppAccount(user)) return { user: null };
    return { user: {
      id: user._id.toString(), displayName: user.displayName, email: user.email,
      credentialVersion: credentialVersionOf(user), mustChangePassword: user.mustChangePassword === true,
      temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt?.toISOString() ?? null,
    } };
  },

  async resetPassword(actor: AdminIdentity, targetId: string, input: { expectedCredentialVersion: number; currentAdminPassword: string }) {
    try {
      if (!Number.isSafeInteger(input.expectedCredentialVersion) || input.expectedCredentialVersion < 0 ||
          input.expectedCredentialVersion >= Number.MAX_SAFE_INTEGER) throw Errors.badRequest('Phiên bản tài khoản không hợp lệ');
      const admin = await credentialService.assertAdmin(actor.userId, actor.credentialVersion);
      if (!await compareCredential(input.currentAdminPassword, admin)) throw Errors.unauthorized('Mật khẩu quản trị không đúng');
      const target = await credentialService.getCurrentCredential(targetId);
      if (!target || !isAppAccount(target)) throw Errors.notFound('Không tìm thấy tài khoản người dùng');
      if (credentialVersionOf(target) !== input.expectedCredentialVersion) throw Errors.conflict('Tài khoản đã thay đổi, hãy tải lại trước khi đặt lại mật khẩu');
      // 192 bits of entropy. Plaintext exists only in this invocation and its one successful response.
      const temporaryPassword = randomBytes(24).toString('base64url');
      const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
      // Revalidate the same admin version after the slow comparisons/hash. Never upgrade the actor snapshot.
      await credentialService.assertAdmin(actor.userId, actor.credentialVersion);
      const expiresAt = new Date(Date.now() + TEMPORARY_PASSWORD_TTL_MS);
      const changed = await userRepository.resetPassword(targetId, input.expectedCredentialVersion, passwordHash, expiresAt);
      if (!changed) throw Errors.conflict('Tài khoản đã thay đổi, hãy tải lại trước khi đặt lại mật khẩu');
      realtimeService.revokeUser(targetId);
      audit('admin.reset', actor.userId, targetId, 'success');
      return { temporaryPassword, expiresAt: expiresAt.toISOString(), credentialVersion: credentialVersionOf(changed) };
    } catch (error) {
      audit('admin.reset', actor.userId, targetId, 'failure');
      throw error;
    }
  },

  async changePassword(actor: AdminIdentity, input: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ changed: true }> {
    try {
      assertNewPassword(input.newPassword, input.confirmPassword);
      const admin = await credentialService.assertAdmin(actor.userId, actor.credentialVersion);
      if (!await compareCredential(input.currentPassword, admin)) throw Errors.unauthorized('Mật khẩu hiện tại không đúng');
      if (await compareCredential(input.newPassword, admin)) throw Errors.badRequest('Mật khẩu mới phải khác mật khẩu hiện tại');
      const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
      const changed = await userRepository.changeAdminPassword(actor.userId, actor.credentialVersion, passwordHash);
      if (!changed) throw Errors.unauthorized('Phiên quản trị đã thay đổi, vui lòng đăng nhập lại');
      realtimeService.revokeUser(actor.userId);
      audit('admin.change', actor.userId, actor.userId, 'success');
      return { changed: true };
    } catch (error) {
      audit('admin.change', actor.userId, actor.userId, 'failure');
      throw error;
    }
  },
};
