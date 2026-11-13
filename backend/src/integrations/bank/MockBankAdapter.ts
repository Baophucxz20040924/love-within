import { createHash } from 'node:crypto';
import { BankFeedError, type BankFeedProvider, type BankFeedTxn } from './BankFeedProvider.js';

const HOUR = 3_600_000;
const COUNT = 12;

/**
 * DEV ONLY. Deterministic fake MB feed so smoke tests and the UI work without a real account.
 *   - token starting with "invalid" → TOKEN_INVALID (like thueapibank's 403);
 *   - token starting with "down"    → NETWORK (retryable);
 *   - anything else → 12 transactions spread over the last ~6.5 days, same IDs/amounts on every call.
 */
export class MockBankAdapter implements BankFeedProvider {
  readonly name = 'mock';

  async fetchRecent(token: string): Promise<BankFeedTxn[]> {
    if (token.startsWith('invalid')) throw new BankFeedError('TOKEN_INVALID', 'Token không hợp lệ', false);
    if (token.startsWith('down')) throw new BankFeedError('NETWORK', 'Không kết nối được thueapibank', true);

    // Anchor at the start of the current Vietnam day so times are stable within a day and never in the future.
    const now = Date.now();
    const vnDayStart = Math.floor((now + 7 * HOUR) / (24 * HOUR)) * 24 * HOUR - 7 * HOUR;
    const txns: BankFeedTxn[] = [];
    for (let i = 0; i < COUNT; i++) {
      const h = createHash('sha256').update(`${token}:${i}`).digest();
      const digits = BigInt(`0x${h.subarray(0, 8).toString('hex')}`).toString().padStart(14, '0').slice(0, 14);
      txns.push({
        providerTxnId: `FT${digits}`,
        direction: i % 4 === 0 ? 'in' : 'out',
        amount: (h.readUInt16BE(8) % 500 + 1) * 1000, // 1.000đ – 500.000đ
        occurredAt: new Date(vnDayStart - (i * 13 + 0.5) * HOUR),
      });
    }
    return txns;
  }
}
