/** A browser's push subscription (PushSubscription.toJSON() in the app). */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOptions {
  /** Seconds the push service keeps the message while the phone is offline. */
  ttlSec: number;
  urgency: 'normal' | 'high';
}

export type PushResult =
  | { status: 'ok' }
  /** 404 / 410 from the push service: the subscription is gone for good (delete it). */
  | { status: 'gone'; statusCode: number }
  | { status: 'error'; statusCode: number | null; message: string };

/**
 * Web Push sender (plan/OPERATIONS.md, N4). The payload is encrypted for the browser (RFC 8291), so the push service
 * (Google, Apple, Mozilla, Microsoft) cannot read it. Never throws for a failed send: the result says what happened.
 */
export interface PushProvider {
  /** false when no VAPID keys are set: push is off and the app still runs. */
  readonly enabled: boolean;
  /** VAPID public key (base64url) for PushManager.subscribe; null when disabled. */
  readonly publicKey: string | null;
  send(target: PushTarget, payload: string, opts: PushSendOptions): Promise<PushResult>;
}
