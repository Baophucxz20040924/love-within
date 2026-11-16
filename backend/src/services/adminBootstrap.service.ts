import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { ADMIN_EMAIL, BCRYPT_ROUNDS, isAdminAccount } from './credential.service.js';

/** Explicit operator operation only. Never called from application startup or public APIs. */
export async function bootstrapAdmin(password: string): Promise<'created' | 'exists'> {
  // A six-character initial secret is the explicitly approved bootstrap-only exception.
  // No default or plaintext credential is embedded here or in the command.
  if (password.length < 6 || Buffer.byteLength(password, 'utf8') > 72 || password.includes('\0')) {
    throw new Error('Bootstrap password must contain at least 6 characters and at most 72 UTF-8 bytes');
  }
  const existing = await User.findOne({ email: ADMIN_EMAIL }).exec();
  if (existing) {
    if (!isAdminAccount(existing)) throw new Error('Reserved email collision: refusing to promote or overwrite an existing account');
    return 'exists';
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    await User.create({
      email: ADMIN_EMAIL, displayName: 'Administrator', passwordHash,
      role: 'admin', credentialVersion: 0, mustChangePassword: false, temporaryPasswordExpiresAt: null,
    });
    return 'created';
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const winner = await User.findOne({ email: ADMIN_EMAIL }).exec();
    if (!winner || !isAdminAccount(winner)) throw new Error('Reserved email collision: refusing to promote or overwrite an existing account');
    return 'exists';
  }
}
