import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { BankFeedError, parseVnDateTime, type BankFeedProvider, type BankFeedTxn } from './BankFeedProvider.js';

/**
 * thueapibank.vn MBBank API V2: GET {base}/historyapimbv2/{token}
 *   → { status: "success", message, transactions: [{ transactionID, amount, description, transactionDate, type }] }
 * Verified with a real account on 06/11/2026 (plan/PROJECT_SUMMARY.md, C0):
 *   - roughly the last 7 days, newest first; transactionID = MB "FT…" reference, stable across calls;
 *   - amount is a string of digits; transactionDate is "dd/MM/yyyy HH:mm:ss" (Vietnam time); type is IN/OUT.
 *   - an invalid token answers HTTP 403 { status: "error", msg: "Token không hợp lệ" }.
 * V3 (bank password in the URL) must never be used.
 */

const responseSchema = z.object({
  status: z.string(),
  msg: z.string().optional(),
  message: z.string().optional(),
  transactions: z.array(z.unknown()).optional(),
});

const itemSchema = z.object({
  transactionID: z.union([z.string(), z.number()]),
  amount: z.union([z.string(), z.number()]),
  transactionDate: z.string(),
  type: z.string(),
});

const MAX_AMOUNT = 100_000_000_000; // 100 tỷ: anything above is a parse error, not a real transfer.

export class ThueApiBankAdapter implements BankFeedProvider {
  readonly name = 'thueapibank';

  async fetchRecent(token: string): Promise<BankFeedTxn[]> {
    const json = await this.request(token);
    const raw = json.transactions ?? [];
    const txns: BankFeedTxn[] = [];
    let skipped = 0;
    for (const item of raw) {
      const t = toTxn(item);
      if (t) txns.push(t);
      else skipped++;
    }
    if (skipped > 0) logger.warn('thueapibank: skipped unparseable transactions', { skipped, total: raw.length });
    return txns;
  }

  private async request(token: string): Promise<z.infer<typeof responseSchema>> {
    const url = `${env.bank.thueapibankBaseUrl.replace(/\/$/, '')}/historyapimbv2/${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.bank.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'look-within/1.0' },
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw aborted
        ? new BankFeedError('TIMEOUT', 'thueapibank không phản hồi', true)
        : new BankFeedError('NETWORK', 'Không kết nối được thueapibank', true);
    } finally {
      clearTimeout(timer);
    }

    let parsed: z.infer<typeof responseSchema> | null = null;
    try {
      const r = responseSchema.safeParse(JSON.parse(text));
      if (r.success) parsed = r.data;
    } catch {
      /* not JSON (e.g. Cloudflare page) */
    }
    const providerMsg = scrub(parsed?.msg ?? parsed?.message ?? '', token);

    // Only trust a JSON error body: a bare 403 may be Cloudflare blocking us, not a bad token.
    if (parsed && parsed.status !== 'success' && (res.status === 401 || res.status === 403 || /token/i.test(providerMsg))) {
      throw new BankFeedError('TOKEN_INVALID', providerMsg || 'Token không hợp lệ', false);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new BankFeedError('PROVIDER_ERROR', `thueapibank lỗi ${res.status}`, true);
    }
    if (!parsed) throw new BankFeedError('BAD_RESPONSE', `thueapibank trả dữ liệu không hợp lệ (HTTP ${res.status})`, true);
    if (parsed.status !== 'success') {
      throw new BankFeedError('PROVIDER_ERROR', providerMsg || `thueapibank trả trạng thái ${parsed.status}`, false);
    }
    return parsed;
  }
}

function toTxn(item: unknown): BankFeedTxn | null {
  const r = itemSchema.safeParse(item);
  if (!r.success) return null;
  const type = r.data.type.trim().toUpperCase();
  if (type !== 'IN' && type !== 'OUT') return null;
  const amount = typeof r.data.amount === 'number' ? r.data.amount : Number(r.data.amount.replace(/[,\s]/g, ''));
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  const occurredAt = parseVnDateTime(r.data.transactionDate);
  if (!occurredAt) return null;
  const providerTxnId = String(r.data.transactionID).trim();
  if (!providerTxnId || providerTxnId.length > 100) return null;
  return { providerTxnId, direction: type === 'IN' ? 'in' : 'out', amount, occurredAt };
}

/** Provider messages are shown to the user and stored; make sure the token can never leak through them. */
function scrub(message: string, token: string): string {
  return message.split(token).join('***').slice(0, 160);
}
