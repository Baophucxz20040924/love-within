import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { bootstrapAdmin } from '../services/adminBootstrap.service.js';

/**
 * Operator-only command. No dotenv loading, argument/default password, startup hook or password output.
 * Feed the initial password using a secret-manager pipe/stdin, and MONGODB_URI via the operator environment.
 */
async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--password-stdin' || process.stdin.isTTY) {
    throw new Error('Usage: bootstrap-admin --password-stdin (secret on piped stdin; MONGODB_URI in environment)');
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI must be explicitly set in the operator environment');
  // Accept a single trailing line ending from a secret manager, not arbitrary whitespace trimming.
  let password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (password.includes('\n') || password.includes('\r')) throw new Error('Provide exactly one password');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false, maxPoolSize: 1 });
    // Uniqueness must exist before the insert; createIndexes does not remove unrelated indexes.
    await User.createIndexes();
    const result = await bootstrapAdmin(password);
    password = '';
    console.log(result === 'created' ? 'Admin created. Sign in through the separate admin page.' : 'Admin already exists. No credentials changed.');
  } finally {
    password = '';
    await mongoose.disconnect();
  }
}

void main().catch(() => {
  // Mongo errors may contain credentials/URIs; fail without printing input or arbitrary error text.
  console.error('Admin bootstrap failed. Verify explicit input, connectivity, unique email index, and reserved-email ownership. No existing account is promoted or overwritten.');
  process.exitCode = 1;
});
