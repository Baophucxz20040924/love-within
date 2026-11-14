'use strict';
// Preload only for the owned local browser fixture. Never load .env or inherited provider secrets.
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
