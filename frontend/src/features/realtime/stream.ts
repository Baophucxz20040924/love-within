import { authenticatedResponse } from '../../lib/apiClient';
import type { Space } from '../../lib/spaceStore';
import { EventParser, type RealtimeEvent } from './parser';

const HEARTBEAT_TIMEOUT = 55_000;
const MAX_BACKOFF = 30_000;

export function reconnectDelay(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + random * 0.5));
}

export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(120_000, delay)) : 0;
}

/** One instance per eligible generation/space. Stop guards all delayed callbacks. */
export class RealtimeStream {
  private stopped = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  constructor(private space: Space, private onEvent: (event: RealtimeEvent) => void, private onDisconnect?: () => void) {}

  start(): void { void this.connect(); }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.heartbeat !== undefined) clearTimeout(this.heartbeat);
  }

  private touch(controller: AbortController): void {
    if (this.heartbeat !== undefined) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    let minimumDelay = 0;
    try {
      // Includes time waiting for response headers. A slow refresh remains shared with REST.
      this.touch(controller);
      const res = await authenticatedResponse(`/realtime?space=${this.space}`, {
        signal: controller.signal, headers: { Accept: 'text/event-stream' },
      });
      if (this.stopped || controller.signal.aborted) { void res.body?.cancel().catch(() => undefined); return; }
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) minimumDelay = retryAfter(res.headers.get('Retry-After'));
        throw new Error(`SSE HTTP ${res.status}`);
      }
      if (!res.body || !res.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')) throw new Error('Invalid SSE response');
      const reader = res.body.getReader();
      const parser = new EventParser();
      try {
        while (!this.stopped && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (this.stopped || controller.signal.aborted) break;
          if (done) break;
          this.touch(controller);
          for (const event of parser.push(value)) {
            if (this.stopped || controller.signal.aborted) break;
            if (event.type === 'ready') this.attempt = 0;
            this.onEvent(event);
          }
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      // A later reconnect/resume resynchronizes missed hints; existing polling remains fallback.
    } finally {
      if (this.heartbeat !== undefined) clearTimeout(this.heartbeat);
      this.heartbeat = undefined;
      if (!this.stopped) {
        try { this.onDisconnect?.(); } catch { /* A callback must not stop reconnect. */ }
        const delay = Math.max(minimumDelay, reconnectDelay(this.attempt++));
        this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, delay);
      }
    }
  }
}
