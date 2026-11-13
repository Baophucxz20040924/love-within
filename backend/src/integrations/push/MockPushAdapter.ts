import { createECDH } from 'node:crypto';
import type { PushProvider, PushResult, PushSendOptions, PushTarget } from './PushProvider.js';

export interface MockPushSend {
  at: string;
  endpoint: string;
  /** The JSON payload as the service worker would receive it (not encrypted here). */
  payload: unknown;
  bytes: number;
  ttlSec: number;
  urgency: PushSendOptions['urgency'];
  result: PushResult['status'];
  statusCode: number | null;
}

/** Sends kept in RAM (oldest dropped first). */
const MAX_SENDS = 1000;

/**
 * DEV-ONLY push sender (PUSH_PROVIDER=mock, refused in production): records every send in RAM instead of calling a
 * push service. Smoke tests read and clear the record and make an endpoint fail through /api/dev-push.
 * The VAPID public key is VAPID_PUBLIC_KEY when set, else a P-256 key made at startup, so a browser can still call
 * PushManager.subscribe against it (nothing is ever delivered to the browser).
 */
export class MockPushAdapter implements PushProvider {
  readonly enabled = true;
  readonly publicKey: string;
  private sends: MockPushSend[] = [];
  private readonly failures = new Map<string, { statusCode: number; left: number }>();

  constructor(publicKey: string | null) {
    if (publicKey) {
      this.publicKey = publicKey;
    } else {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      this.publicKey = ecdh.getPublicKey().toString('base64url');
    }
  }

  async send(target: PushTarget, payload: string, opts: PushSendOptions): Promise<PushResult> {
    let result: PushResult = { status: 'ok' };
    const fail = this.failures.get(target.endpoint);
    if (fail) {
      fail.left -= 1;
      if (fail.left <= 0) this.failures.delete(target.endpoint);
      result =
        fail.statusCode === 404 || fail.statusCode === 410
          ? { status: 'gone', statusCode: fail.statusCode }
          : { status: 'error', statusCode: fail.statusCode, message: `mock push service answered ${fail.statusCode}` };
    }
    let parsed: unknown = payload;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // keep the raw string
    }
    this.sends.push({
      at: new Date().toISOString(),
      endpoint: target.endpoint,
      payload: parsed,
      bytes: Buffer.byteLength(payload, 'utf8'),
      ttlSec: opts.ttlSec,
      urgency: opts.urgency,
      result: result.status,
      statusCode: result.status === 'ok' ? 201 : result.statusCode,
    });
    if (this.sends.length > MAX_SENDS) this.sends = this.sends.slice(-MAX_SENDS);
    return result;
  }

  list(endpoint?: string): MockPushSend[] {
    return endpoint ? this.sends.filter((s) => s.endpoint === endpoint) : [...this.sends];
  }

  clear(): void {
    this.sends = [];
    this.failures.clear();
  }

  /** The next `times` sends to this endpoint get `statusCode` (404/410 = subscription gone, else a temporary error). */
  failNext(endpoint: string, statusCode: number, times: number): void {
    this.failures.set(endpoint, { statusCode, left: times });
  }
}
