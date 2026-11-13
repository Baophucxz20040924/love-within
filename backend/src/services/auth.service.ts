import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/user.repository.js';
import { tokenService } from './token.service.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { UserDoc } from '../models/User.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const BCRYPT_ROUNDS = 11;

/**
 * Hash compared against when the email is unknown, so a login for a non-existent account
 * costs the same bcrypt time as a wrong password (no account discovery by response timing).
 */
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= bcrypt.hash('look-within-timing-equalizer', BCRYPT_ROUNDS));

function issueTokens(user: UserDoc): AuthTokens {
  const id = user._id.toString();
  return {
    accessToken: tokenService.signAccess(id),
    refreshToken: tokenService.signRefresh(id),
  };
}

export const authService = {
  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<AuthTokens> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) {
      throw Errors.conflict('Email đã được sử dụng');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await userRepository.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });
    logger.info('User registered', { userId: user._id.toString() });
    return issueTokens(user);
  },

  async login(input: { email: string; password: string }): Promise<AuthTokens> {
    const user = await userRepository.findByEmail(input.email);
    const match = await bcrypt.compare(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !match) {
      throw Errors.unauthorized('Email hoặc mật khẩu không đúng');
    }
    return issueTokens(user);
  },

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = tokenService.verifyRefresh(refreshToken);
    const user = await userRepository.findById(payload.sub);
    if (!user) {
      throw Errors.unauthorized('Tài khoản không tồn tại');
    }
    return issueTokens(user);
  },
};
