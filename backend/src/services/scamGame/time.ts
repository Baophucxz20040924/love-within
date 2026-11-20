import type { ScamMatch } from '../../models/ScamGamePlayer.js';

export const SCAM_DURATION_MS = 15 * 60_000;
export function matchDeadline(match: ScamMatch): number {
  const started = Date.parse(match.startedAt);
  // Invalid legacy timestamps must not grant another fifteen minutes.
  return Number.isFinite(started) ? started + SCAM_DURATION_MS : 0;
}
export function matchExpired(match: ScamMatch, now = Date.now()): boolean {
  return match.status === 'active' && now >= matchDeadline(match);
}
export function conversationTime(match: ScamMatch, now = Date.now()) {
  const remainingSeconds = Math.max(0, Math.min(900, Math.ceil((matchDeadline(match) - now) / 1000)));
  return { limitSeconds: 900, elapsedSeconds: 900 - remainingSeconds, remainingSeconds };
}
