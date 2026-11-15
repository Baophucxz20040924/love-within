'use strict';
// Explicitly invoked wrapper, not a preload for server.ts. Never production; no dotenv/provider credentials.
// Build backend first, then: node tests/personal-wallets/mock-runtime.cjs --local-mock-runtime
// UI is separately owned at 127.0.0.1:5175. This process owns API 4002; stop gracefully to remove its collections.
if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw Error('Explicit local mock opt-in required');
require('dotenv').config = () => ({ parsed: {} });
const { randomBytes } = require('node:crypto');
const safe = { ...process.env };
for (const key of Object.keys(safe)) {
  if (/^(JWT_|MONGODB_|AWS_|S3_|BEEKNOEE_|THUEAPIBANK_|BANK_|AI_|STORAGE_|PUSH_|VAPID_|OPS_|ORIGIN_)/.test(key)) delete safe[key];
}
Object.assign(safe, {
  NODE_ENV: 'development', PORT: '4002', CORS_ORIGIN: 'http://127.0.0.1:5175',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/lookwithin_dev',
  JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  STORAGE_PROVIDER: 'memory', AI_PROVIDER: 'mock', AI_CHAT_PROVIDER: 'mock', BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock',
  SCHEDULER_ENABLED: 'false', NODE_APP_INSTANCE: '1', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
  BANK_TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
});
process.env = safe;
const mongoose = require('mongoose');
const namespace = require('./namespace.cjs').install(mongoose);
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../dist');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
let server, stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (server) await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections(); // release open SSE connections after refusing new requests
  });
  if (mongoose.connection.readyState === 1) await namespace.cleanup();
  await mongoose.disconnect();
}
async function main() {
  // Import complete graph before connecting; server.ts is deliberately NOT imported (no syncIndexes or recovery).
  const { createApp } = await load('app.js');
  const { questService } = await load('services/quest.service.js');
  namespace.verify();
  await mongoose.connect(namespace.URI, { serverSelectionTimeoutMS: 3000 });
  await namespace.prepare();
  await questService.seedDefaults();
  namespace.verify();
  const app = createApp();
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(4002, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  console.log(`Isolated mock API 127.0.0.1:4002; collections: ${namespace.prefix}*`);
}
const stop = () => shutdown().then(() => process.exit(0), () => process.exit(1));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
// Parent can send a newline-delimited stop command over the owned child's stdin on Windows.
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdin += chunk;
  const lines = stdin.split(/\r?\n/); stdin = lines.pop();
  if (lines.some(line => line.trim() === 'stop')) void stop();
  if (stdin.length > 1024) stdin = '';
});
main().catch(async error => {
  // Avoid logging connection URIs, secrets or user data.
  console.error('Isolated mock startup failed:', error?.name || 'Error');
  await shutdown().catch(() => {});
  process.exitCode = 1;
});
