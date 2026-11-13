import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';

/** AES-256-GCM ciphertext, all parts base64. */
export interface EncryptedSecret {
  iv: string;
  tag: string;
  data: string;
}

let key: Buffer | null = null;

function getKey(): Buffer {
  if (key) return key;
  const raw = env.bank.tokenEncKey;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('BANK_TOKEN_ENC_KEY must be 32 bytes encoded as base64');
    key = k;
  } else {
    if (isProd) throw new Error('BANK_TOKEN_ENC_KEY is required in production');
    logger.warn('BANK_TOKEN_ENC_KEY is not set, using a fixed development key (dev only)');
    key = createHash('sha256').update('look-within-dev-bank-token-key').digest();
  }
  return key;
}

/** Fail fast at startup when the key is missing/invalid in production. */
export function assertSecretKey(): void {
  getKey();
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(plain: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const iv = Buffer.from(secret.iv, 'base64');
  const tag = Buffer.from(secret.tag, 'base64');
  // A truncated auth tag would weaken GCM's integrity check; only accept the full 16 bytes.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8');
}
