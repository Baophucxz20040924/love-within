import { isProd } from '../config/env.js';
import { currentRequestId } from '../middleware/requestCorrelation.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
interface LogContext {
  coupleId?: string;
  userId?: string;
  [key: string]: unknown;
}

// Deliberately allow metadata, not arbitrary nested payloads/provider errors or private user content.
const SAFE_STRING = /^(?:code|method|env|provider|kind|job|jobName|type|targetType|action|status|poll|section|outcome)$/;
const PRIVATE_KEY = /(?:body|content|text|note|email|password|secret|token|authorization|cookie|header|query|url|uri|endpoint|key|message|error|stack|prompt|reply|name|title|description)/i;

function safeContext(context?: LogContext): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context ?? {}).slice(0, 50)) {
    if (PRIVATE_KEY.test(key)) {
      // Numeric metrics such as tokens/replyChars are counts, never text content.
      safe[key] = typeof value === 'number' && Number.isFinite(value) ? value : '[REDACTED]';
    } else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) {
      safe[key] = value;
    } else if ((key === 'actorId' || key === 'targetId') && typeof value === 'string' && /^[a-f\d]{24}$/i.test(value)) {
      // Credential audit identifiers only; never arbitrary client text or private profile fields.
      safe[key] = value;
    } else if (key === 'routeTemplate' && typeof value === 'string' && /^(?:unmatched|\/[a-zA-Z0-9_:/.-]*)$/.test(value) && value.length <= 150) {
      safe[key] = value;
    } else if (SAFE_STRING.test(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) {
      safe[key] = value;
    } else {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}

/** Defense in depth; call sites must still use static event messages, never interpolate private content. */
function safeMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:https?|mongodb(?:\+srv)?):\/\/\S+/gi, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 300);
}

function emit(level: Level, message: string, context?: LogContext): void {
  const safe = safeContext(context);
  const event = safeMessage(message);
  const requestId = currentRequestId();
  const metadata = { ...safe, ...(requestId ? { requestId } : {}) };
  const entry = { ...metadata, ts: new Date().toISOString(), level, message: event };
  const line = isProd ? JSON.stringify(entry) : `[${level.toUpperCase()}] ${event}${Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => { if (!isProd) emit('debug', message, context); },
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
};
