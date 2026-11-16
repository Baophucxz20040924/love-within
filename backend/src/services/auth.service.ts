import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/user.repository.js';
import { tokenService } from './token.service.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { realtimeService } from './realtime.service.js';
import {
  ADMIN_EMAIL, BCRYPT_ROUNDS, assertNewPassword, compareCredential, credentialService,
  credentialVersionOf, isAppAccount, normalizeEmail,
} from './credential.service.js';

export interface AuthTokens { accessToken: string; refreshToken: string }
export interface PasswordChangeRequired { status: 'password_change_required'; passwordChangeToken: string; expiresAt: string }
export type LoginResult = AuthTokens | PasswordChangeRequired;

/** Always issue from the authenticated snapshot, NEVER a later DB version fetched after bcrypt. */
function issueTokens(userId: string, version: number): AuthTokens {
  return { accessToken: tokenService.signAccess(userId, version), refreshToken: tokenService.signRefresh(userId, version) };
}

export const authService = {
  async register(input: { email: string; password: string; displayName: string }): Promise<AuthTokens> {
    const email = normalizeEmail(input.email);
    if (email === ADMIN_EMAIL) throw Errors.conflict('Email không khả dụng');
    assertNewPassword(input.password, input.password);
    if (await userRepository.findByEmail(email)) throw Errors.conflict('Email đã được sử dụng');
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    let user;
    try {
      // Explicit allowlist: never pass a client role or credential state to persistence.
      user = await userRepository.create({ email, passwordHash, displayName: input.displayName });
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) throw Errors.conflict('Email đã được sử dụng');
      throw error;
    }
    logger.info('User registered', { userId: user._id.toString() });
    return issueTokens(user._id.toString(), credentialVersionOf(user));
  },

  async login(input: { email: string; password: string }): Promise<LoginResult> {
    const user = await userRepository.findByEmail(input.email);
    // Capture before async bcrypt (even a mutable repository/test double cannot upgrade this snapshot).
    const version = user ? credentialVersionOf(user) : 0;
    const id = user?._id.toString();
    const match = await compareCredential(input.password, user);
    if (!user || !id || !match || !isAppAccount(user)) throw Errors.unauthorized('Email hoặc mật khẩu không đúng');
    if (user.mustChangePassword) {
      const current = await credentialService.assertPasswordChange(id, version);
      const grant = tokenService.signPasswordChange(id, version, current.temporaryPasswordExpiresAt!.getTime());
      return { status: 'password_change_required', passwordChangeToken: grant.token, expiresAt: grant.expiresAt };
    }
    await credentialService.assertApp(id, version);
    return issueTokens(id, version);
  },

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = tokenService.verifyRefresh(refreshToken);
    await credentialService.assertApp(payload.sub, payload.credentialVersion);
    return issueTokens(payload.sub, payload.credentialVersion);
  },

  async completePasswordChange(input: { passwordChangeToken: string; newPassword: string; confirmPassword: string }): Promise<AuthTokens> {
    assertNewPassword(input.newPassword, input.confirmPassword);
    const payload = tokenService.verifyPasswordChange(input.passwordChangeToken);
    const user = await credentialService.assertPasswordChange(payload.sub, payload.credentialVersion);
    if (await compareCredential(input.newPassword, user)) throw Errors.badRequest('Mật khẩu mới phải khác mật khẩu tạm');
    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
    // Enforce the grant deadline both after bcrypt and in the atomic DB write.
    tokenService.verifyPasswordChange(input.passwordChangeToken);
    const changed = await userRepository.completePasswordChange(
      payload.sub, payload.credentialVersion, user.temporaryPasswordExpiresAt!, passwordHash, new Date(payload.expiresAtMs),
    );
    if (!changed) throw Errors.unauthorized('Quyền đổi mật khẩu đã hết hạn hoặc đã được sử dụng');
    realtimeService.revokeUser(payload.sub);
    logger.info('Recovery password changed', { actorId: payload.sub, targetId: payload.sub, outcome: 'success' });
    return issueTokens(changed._id.toString(), credentialVersionOf(changed));
  },
};
