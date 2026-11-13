/** One transaction from a bank feed, normalized. No description / balance / account number on purpose. */
export interface BankFeedTxn {
  /** Bank reference (MB "FT..." code), stable across calls. */
  providerTxnId: string;
  direction: 'in' | 'out';
  /** VND, positive integer. */
  amount: number;
  occurredAt: Date;
}

export interface BankFeedProvider {
  readonly name: string;
  /** Recent transactions (thueapibank returns roughly the last 7 days, newest first). */
  fetchRecent(token: string): Promise<BankFeedTxn[]>;
}

export type BankFeedErrorCode = 'TOKEN_INVALID' | 'PROVIDER_ERROR' | 'BAD_RESPONSE' | 'NETWORK' | 'TIMEOUT';

/** Never put the token in `message`; it is stored in BankConnection.lastError and may be shown to the user. */
export class BankFeedError extends Error {
  readonly code: BankFeedErrorCode;
  /** true for transient failures (network, timeout, 5xx, 429). */
  readonly retryable: boolean;
  constructor(code: BankFeedErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'BankFeedError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Parse "dd/MM/yyyy HH:mm:ss" (or "dd/MM/yyyy", or "dd/MM/yyyy HH:mm") as Vietnam time (UTC+7, no DST).
 * Returns null for anything that is not a real calendar date.
 */
export function parseVnDateTime(value: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+07:00`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // Reject roll-over dates such as 31/02 (Date.parse would accept and shift them).
  const check = new Date(t + 7 * 3_600_000);
  if (check.getUTCDate() !== Number(dd) || check.getUTCMonth() + 1 !== Number(mm)) return null;
  return d;
}
