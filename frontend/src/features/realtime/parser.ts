export const DOMAINS = [
  'account', 'couple', 'pairing', 'quests', 'wallet', 'water', 'market', 'proposals',
  'stories', 'questions', 'events', 'letters', 'moods', 'bucket', 'moments', 'savings',
  'finance', 'assistant', 'friends', 'friend-posts', 'friend-events', 'friend-outings',
  'friend-notifications', 'friend-profile',
] as const;
export type Domain = typeof DOMAINS[number];
export type RealtimeEvent = { type: 'ready' | 'dirty' | 'access'; domains: Domain[] };
const domainSet = new Set<string>(DOMAINS);
const MAX_BUFFER = 64 * 1024;

/** Incremental SSE parser; partial lines and frames are bounded, including across CRLF splits. */
export class EventParser {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private frameSize = 0;

  push(chunk: Uint8Array): RealtimeEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const result: RealtimeEvent[] = [];
    while (true) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match || (match[0] === '\r' && match.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.frameSize += line.length + match[0].length;
      if (this.frameSize > MAX_BUFFER) throw new Error('SSE frame too large');
      if (!line) {
        const frame = this.parseFrame();
        if (frame) result.push(frame);
        this.event = '';
        this.data = [];
        this.frameSize = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    if (this.buffer.length + this.frameSize > MAX_BUFFER) throw new Error('SSE frame too large');
    return result;
  }

  private parseFrame(): RealtimeEvent | null {
    if (this.event !== 'ready' && this.event !== 'dirty' && this.event !== 'access') return null;
    try {
      const payload: unknown = JSON.parse(this.data.join('\n'));
      if (!payload || typeof payload !== 'object') return null;
      const { version, domains } = payload as { version?: unknown; domains?: unknown };
      if (version !== 1 || !Array.isArray(domains) || domains.length > DOMAINS.length ||
          !domains.every((domain) => typeof domain === 'string' && domainSet.has(domain))) return null;
      if (this.event === 'ready' && domains.length !== 0) return null;
      return { type: this.event, domains: [...new Set(domains)] as Domain[] };
    } catch {
      return null;
    }
  }
}
