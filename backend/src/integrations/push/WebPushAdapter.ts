import { logger } from '../../utils/logger.js';
import type { PushProvider, PushResult, PushSendOptions, PushTarget } from './PushProvider.js';

type WebPushModule = typeof import('web-push');

/** A push service that does not answer within this time counts as a failed send. */
const SEND_TIMEOUT_MS = 10_000;

function base64UrlBytes(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  return Buffer.from(value, 'base64url').length;
}

/** Why the VAPID settings cannot be used, or null when they look right. */
function vapidProblem(publicKey: string, privateKey: string, subject: string): string | null {
  if (!publicKey || !privateKey || !subject) return 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required';
  if (base64UrlBytes(publicKey) !== 65) return 'VAPID_PUBLIC_KEY must be the 65-byte public key in base64url (npx web-push generate-vapid-keys)';
  if (base64UrlBytes(privateKey) !== 32) return 'VAPID_PRIVATE_KEY must be the 32-byte private key in base64url';
  if (!/^(mailto:|https:\/\/)/.test(subject)) return 'VAPID_SUBJECT must start with mailto: or https://';
  return null;
}

/**
 * Real Web Push through the `web-push` library (4.x is ESM-only; the backend is CommonJS, so it is loaded with a
 * dynamic import on first use). Missing or malformed VAPID settings turn push off with one WARN; the app still runs.
 */
export class WebPushAdapter implements PushProvider {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  private lib: Promise<WebPushModule> | null = null;

  constructor(private readonly cfg: { vapidPublicKey: string; vapidPrivateKey: string; vapidSubject: string }) {
    const problem = vapidProblem(cfg.vapidPublicKey, cfg.vapidPrivateKey, cfg.vapidSubject);
    this.enabled = problem === null;
    this.publicKey = this.enabled ? cfg.vapidPublicKey : null;
    if (problem) logger.warn(`Web Push disabled: ${problem}`);
  }

  private load(): Promise<WebPushModule> {
    this.lib ??= import('web-push').then((m) => {
      m.setVapidDetails(this.cfg.vapidSubject, this.cfg.vapidPublicKey, this.cfg.vapidPrivateKey);
      return m;
    });
    return this.lib;
  }

  async send(target: PushTarget, payload: string, opts: PushSendOptions): Promise<PushResult> {
    if (!this.enabled) return { status: 'error', statusCode: null, message: 'push disabled' };
    try {
      const webPush = await this.load();
      await webPush.sendNotification(target, payload, { TTL: opts.ttlSec, urgency: opts.urgency, timeout: SEND_TIMEOUT_MS });
      return { status: 'ok' };
    } catch (err) {
      const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : null;
      if (statusCode === 404 || statusCode === 410) return { status: 'gone', statusCode };
      return { status: 'error', statusCode, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
