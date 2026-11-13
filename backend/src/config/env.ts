import dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function asInt(value: string, name: string, min = 1, max = 2_147_483_647): number {
  const text = value.trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function asEnum<T extends string>(value: string, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error(`Environment variable ${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function asBool(value: string, name: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`Environment variable ${name} must be true or false`);
}

export const env = {
  nodeEnv: asEnum(optional('NODE_ENV', 'development'), 'NODE_ENV', ['development', 'test', 'production']),
  port: asInt(optional('PORT', '4000'), 'PORT', 1, 65535),
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173'),
  /** Number of reverse proxies in front of the API (Express "trust proxy"). 1 = one proxy, 2 = CloudFront + Caddy. */
  trustProxyHops: asInt(optional('TRUST_PROXY_HOPS', '1'), 'TRUST_PROXY_HOPS', 0, 10),

  mongoUri: required('MONGODB_URI'),

  jwt: {
    accessSecret: required('JWT_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: optional('JWT_ACCESS_TTL', '15m'),
    refreshTtl: optional('JWT_REFRESH_TTL', '30d'),
  },

  beeknoee: {
    baseUrl: optional('BEEKNOEE_BASE_URL', 'https://platform.beeknoee.com'),
    apiKey: optional('BEEKNOEE_API_KEY', ''),
    /** Must be a vision-capable model on beeknoee. */
    model: optional('BEEKNOEE_MODEL', 'openai/gpt-4o-mini'),
    timeoutMs: asInt(optional('BEEKNOEE_TIMEOUT_MS', '20000'), 'BEEKNOEE_TIMEOUT_MS'),
    /** Text chat model for the finance assistant (plan/FINANCE_ASSISTANT_PLAN.md). Must be a chat model, not an embedding model. */
    chatModel: optional('BEEKNOEE_CHAT_MODEL', 'openai/gpt-5.4-mini'),
    chatTimeoutMs: asInt(optional('BEEKNOEE_CHAT_TIMEOUT_MS', '45000'), 'BEEKNOEE_CHAT_TIMEOUT_MS'),
  },

  /** 'beeknoee' (default) or 'mock' (dev only: returns a fixed ml value). */
  aiProvider: asEnum(optional('AI_PROVIDER', 'beeknoee'), 'AI_PROVIDER', ['beeknoee', 'mock']),
  /** Finance assistant chat: 'beeknoee' | 'mock' (dev only). Defaults to AI_PROVIDER. */
  aiChatProvider: asEnum(optional('AI_CHAT_PROVIDER', optional('AI_PROVIDER', 'beeknoee')), 'AI_CHAT_PROVIDER', ['beeknoee', 'mock']),
  /** 's3' (default) or 'memory' (dev only: in-process store + local upload endpoint). */
  storageProvider: asEnum(optional('STORAGE_PROVIDER', 's3'), 'STORAGE_PROVIDER', ['s3', 'memory']),

  s3: {
    region: optional('AWS_REGION', 'ap-southeast-1'),
    bucket: optional('S3_BUCKET', 'look-within-water'),
    accessKeyId: optional('AWS_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY', ''),
    maxUploadBytes: asInt(optional('S3_MAX_UPLOAD_BYTES', '5242880'), 'S3_MAX_UPLOAD_BYTES'),
  },

  ops: {
    /** Explicit opt-in only. Empty disables production metrics; never trust forwarded loopback. */
    metricsToken: optional('OPS_METRICS_TOKEN', ''),
    memWarnMb: asInt(optional('MEM_WARN_MB', '1500'), 'MEM_WARN_MB'),
  },

  /** Background jobs (plan/PLATFORM_PLAN.md, N2). PM2 instance 0 only; false = no timed jobs in this process. */
  scheduler: {
    enabled: asBool(optional('SCHEDULER_ENABLED', 'true'), 'SCHEDULER_ENABLED'),
  },

  /**
   * Web Push (plan/PLATFORM_PLAN.md, N4). 'webpush' (default) or 'mock' (dev only: records sends in RAM, /api/dev-push).
   * Keys: `npx web-push generate-vapid-keys`. Missing keys in webpush mode = push off (the app still runs, one WARN).
   */
  push: {
    provider: asEnum(optional('PUSH_PROVIDER', 'webpush'), 'PUSH_PROVIDER', ['webpush', 'mock']),
    vapidPublicKey: optional('VAPID_PUBLIC_KEY', ''),
    vapidPrivateKey: optional('VAPID_PRIVATE_KEY', ''),
    /** mailto: address (or https: URL) of the project owner; push services contact it about abuse. */
    vapidSubject: optional('VAPID_SUBJECT', ''),
  },

  /** Personal cash flow from linked bank accounts (plan/CASHFLOW_PLAN.md). Poll only, no webhook. */
  bank: {
    /** 'thueapibank' (default) or 'mock' (dev only: deterministic fake transactions). */
    provider: asEnum(optional('BANK_PROVIDER', 'thueapibank'), 'BANK_PROVIDER', ['thueapibank', 'mock']),
    thueapibankBaseUrl: optional('THUEAPIBANK_BASE_URL', 'https://thueapibank.vn'),
    timeoutMs: asInt(optional('THUEAPIBANK_TIMEOUT_MS', '15000'), 'THUEAPIBANK_TIMEOUT_MS'),
    pollIntervalSec: asInt(optional('BANK_POLL_INTERVAL_SEC', '120'), 'BANK_POLL_INTERVAL_SEC'),
    /** 32 random bytes, base64. Encrypts users' thueapibank tokens at rest. Required in production. */
    tokenEncKey: optional('BANK_TOKEN_ENC_KEY', ''),
  },
} as const;

export const isProd = env.nodeEnv === 'production';

/**
 * Refuse to boot in production with placeholder, short or shared JWT secrets:
 * anyone who can guess the secret can forge a token for any account.
 * Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
 */
function assertJwtSecrets(): void {
  if (!isProd) return;
  const secrets = { JWT_SECRET: env.jwt.accessSecret, JWT_REFRESH_SECRET: env.jwt.refreshSecret };
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < 32 || /change-?me/i.test(value)) {
      throw new Error(`${name} must be a random value of at least 32 characters in production`);
    }
  }
  if (secrets.JWT_SECRET === secrets.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }
}
assertJwtSecrets();
if (env.ops.metricsToken && (env.ops.metricsToken.length < 32 || env.ops.metricsToken.length > 512 || /\s/.test(env.ops.metricsToken))) {
  throw new Error('OPS_METRICS_TOKEN must be an explicitly configured 32–512 character token without whitespace');
}
