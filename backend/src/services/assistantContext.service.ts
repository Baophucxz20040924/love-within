import type { UserDoc } from '../models/User.js';
import { SPEND_CATEGORY_LABELS, type CategoryTotal, type SpendCategory } from '../models/AssistantThread.js';
import { bankTransactionRepository, type TxnRangeRow } from '../repositories/bankTransaction.repository.js';
import { addDays, getLocalDate } from '../utils/date.js';

/**
 * Builds what the finance assistant is allowed to see (plan/PROJECT_SUMMARY.md):
 * the owner's own transactions from the 1st of last month to today, in their timezone.
 * Every number in the data block is computed here, so the model never has to add up long lists.
 * Sent to the model: local date/time, direction, amount, note. Never ids, provider refs or account digits.
 */

const MAX_ROWS = 3000;
/** Up to this many transactions, every one is listed. Above it, only noted ones + big unnoted spends. */
const FULL_LIST_LIMIT = 400;
const NOTED_LIST_LIMIT = 300;
const BIG_UNNOTED_MIN = 200_000;
const BIG_UNNOTED_LIMIT = 100;
const TOP_SPENDS = 10;
/** Distinct spend notes sent for labelling. */
const MAX_NOTE_GROUPS = 150;

export interface Coverage {
  /** Analysis window: 1st of last month → today (local dates). */
  from: string;
  to: string;
  /** Oldest / newest transaction actually stored in the window (null when none). */
  firstDate: string | null;
  lastDate: string | null;
  /** Days from firstDate to today, inclusive (0 when no data). */
  spanDays: number;
  txnCount: number;
  notedCount: number;
  outCount: number;
  outUnnotedCount: number;
}

export interface NoteGroup {
  /** Normalized note (trim, single spaces, lowercase): the labelling key. */
  key: string;
  /** Most recent original spelling, sanitized. */
  sample: string;
  count: number;
  total: number;
}

export interface Snapshot {
  today: string;
  timezone: string;
  coverage: Coverage;
  /** Changes when a transaction is added or a note is edited, or the window moves to a new month. */
  fingerprint: string;
  rows: TxnRangeRow[];
  outNotes: NoteGroup[];
}

export type NoteLabels = Map<string, SpendCategory>;

export function normalizeNote(note: string): string {
  return note.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Notes are user text inside a delimited data block: strip what could break the line format or the block. */
function sanitize(note: string): string {
  return note
    .replace(/[\r\n\t|<>"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

const maxStr = (a: string, b: string) => (a > b ? a : b);
const minStr = (a: string, b: string) => (a < b ? a : b);
const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
const signedVnd = (n: number) => (n > 0 ? `+${vnd(n)}` : n < 0 ? `-${vnd(-n)}` : vnd(0));

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function localTime(d: Date, tz: string): string {
  let f = timeFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(tz, f);
  }
  return f.format(d);
}

const DAY_PARTS = [
  { label: 'sáng (5–10h)', test: (h: number) => h >= 5 && h <= 10 },
  { label: 'trưa (11–13h)', test: (h: number) => h >= 11 && h <= 13 },
  { label: 'chiều (14–17h)', test: (h: number) => h >= 14 && h <= 17 },
  { label: 'tối (18–22h)', test: (h: number) => h >= 18 && h <= 22 },
  { label: 'đêm (23–4h)', test: (h: number) => h >= 23 || h <= 4 },
];

const isWeekend = (localDate: string) => {
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

function totals(rows: TxnRangeRow[]) {
  let totalIn = 0;
  let totalOut = 0;
  for (const r of rows) {
    if (r.direction === 'in') totalIn += r.amount;
    else totalOut += r.amount;
  }
  return { totalIn, totalOut, count: rows.length };
}

export async function buildSnapshot(user: Pick<UserDoc, '_id' | 'timezone'>, now = new Date()): Promise<Snapshot> {
  const timezone = user.timezone;
  const today = getLocalDate(now, timezone);
  const from = `${prevMonth(today.slice(0, 7))}-01`;
  const rows = await bankTransactionRepository.listRange(user._id, from, today, MAX_ROWS);

  const firstDate = rows.length ? rows[rows.length - 1].localDate : null;
  const lastDate = rows.length ? rows[0].localDate : null;
  const outRows = rows.filter((r) => r.direction === 'out');

  const groups = new Map<string, NoteGroup>();
  for (const r of outRows) {
    if (!r.note) continue;
    const key = normalizeNote(r.note);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.total += r.amount;
    } else {
      groups.set(key, { key, sample: sanitize(r.note), count: 1, total: r.amount });
    }
  }

  let maxOccurred = 0;
  let maxNote = 0;
  for (const r of rows) {
    maxOccurred = Math.max(maxOccurred, new Date(r.occurredAt).getTime());
    if (r.noteUpdatedAt) maxNote = Math.max(maxNote, new Date(r.noteUpdatedAt).getTime());
  }

  return {
    today,
    timezone,
    coverage: {
      from,
      to: today,
      firstDate,
      lastDate,
      spanDays: firstDate ? daysInclusive(firstDate, today) : 0,
      txnCount: rows.length,
      notedCount: rows.filter((r) => r.note).length,
      outCount: outRows.length,
      outUnnotedCount: outRows.filter((r) => !r.note).length,
    },
    fingerprint: `${from}|${rows.length}|${maxOccurred}|${maxNote}`,
    rows,
    outNotes: [...groups.values()].sort((a, b) => b.total - a.total),
  };
}

/** Spend totals per category. Server-side, so the model's arithmetic never reaches the UI. */
export function categoryBreakdown(snap: Snapshot, labels: NoteLabels): CategoryTotal[] {
  const by = new Map<CategoryTotal['key'], { amount: number; count: number }>();
  let totalOut = 0;
  for (const r of snap.rows) {
    if (r.direction !== 'out') continue;
    totalOut += r.amount;
    const key = r.note ? (labels.get(normalizeNote(r.note)) ?? 'other') : 'unnoted';
    const e = by.get(key) ?? { amount: 0, count: 0 };
    e.amount += r.amount;
    e.count++;
    by.set(key, e);
  }
  return [...by.entries()]
    .map(([key, e]) => ({ key, amount: e.amount, count: e.count, share: totalOut ? Math.round((e.amount / totalOut) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Distinct spend notes as `nX: "note"` lines; `keys[i]` is the normalized note for `n{i+1}`. */
export function renderNoteList(snap: Snapshot): { text: string; keys: string[] } {
  const top = snap.outNotes.slice(0, MAX_NOTE_GROUPS);
  if (top.length === 0) return { text: 'Không có khoản chi nào có ghi chú.', keys: [] };
  const lines = top.map((g, i) => `n${i + 1}: "${g.sample}" (${g.count} lần, ${vnd(g.total)})`);
  return { text: `Ghi chú của các khoản chi (mã: "ghi chú" (số lần, tổng tiền)):\n${lines.join('\n')}`, keys: top.map((g) => g.key) };
}

/** The delimited data block the model must answer from. */
export function renderDataBlock(snap: Snapshot, labels?: NoteLabels): string {
  const { coverage: c, today, timezone: tz, rows } = snap;
  const out: string[] = ['<<<DU_LIEU'];
  out.push(`Hôm nay: ${today} (${tz}). Cửa sổ phân tích: ${c.from} → ${c.to} (tháng trước và tháng này).`);
  if (!c.firstDate) {
    out.push('Không có giao dịch nào trong cửa sổ này.', 'DU_LIEU>>>');
    return out.join('\n');
  }
  if (c.firstDate > c.from) {
    out.push(
      `Có dữ liệu từ ${c.firstDate} (${c.spanDays} ngày tính tới hôm nay). ` +
        `Trước ${c.firstDate} KHÔNG có dữ liệu (app chưa liên kết ngân hàng), không có nghĩa là không chi tiêu.`,
    );
  } else {
    out.push(`Có dữ liệu cho cả cửa sổ (${c.spanDays} ngày).`);
  }
  const unnotedOut = rows.filter((r) => r.direction === 'out' && !r.note).reduce((s, r) => s + r.amount, 0);
  out.push(
    `Tổng: ${c.txnCount} giao dịch, ${c.notedCount} có ghi chú. Tiền ra: ${c.outCount} giao dịch, ${c.outUnnotedCount} chưa ghi chú ` +
      `(tổng tiền ra chưa ghi chú ${vnd(unnotedOut)}).`,
  );

  // Per month, with only the days we actually have.
  out.push('', 'Theo tháng:');
  for (const m of [c.from.slice(0, 7), today.slice(0, 7)]) {
    const start = maxStr(`${m}-01`, c.firstDate);
    const end = minStr(monthEnd(m), today);
    const days = end >= start ? daysInclusive(start, end) : 0;
    if (days === 0) {
      out.push(`- ${m}: không có dữ liệu.`);
      continue;
    }
    const t = totals(rows.filter((r) => r.localDate.startsWith(m)));
    const partial = m === today.slice(0, 7) ? ', tính tới hôm nay' : start > `${m}-01` ? ', thiếu đầu tháng' : '';
    out.push(
      `- ${m} (${days} ngày có dữ liệu${partial}): vào ${vnd(t.totalIn)}, ra ${vnd(t.totalOut)}, ` +
        `chênh lệch ${signedVnd(t.totalIn - t.totalOut)}, ${t.count} giao dịch, chi trung bình ${vnd(t.totalOut / days)}/ngày.`,
    );
  }

  // Last 7 days vs the 7 before (only when fully covered).
  const w1 = addDays(today, -6);
  const last7 = totals(rows.filter((r) => r.localDate >= w1));
  out.push(`7 ngày gần nhất (${w1} → ${today}): vào ${vnd(last7.totalIn)}, ra ${vnd(last7.totalOut)}, ${last7.count} giao dịch.`);
  const w0 = addDays(today, -13);
  if (c.firstDate <= w0) {
    const prev7 = totals(rows.filter((r) => r.localDate >= w0 && r.localDate < w1));
    out.push(`7 ngày trước đó (${w0} → ${addDays(today, -7)}): vào ${vnd(prev7.totalIn)}, ra ${vnd(prev7.totalOut)}, ${prev7.count} giao dịch.`);
  } else {
    out.push('Chưa đủ dữ liệu để so sánh với 7 ngày trước đó.');
  }

  const outRows = rows.filter((r) => r.direction === 'out');

  // Time of day.
  const parts = DAY_PARTS.map((p) => ({ label: p.label, amount: 0, count: 0 }));
  for (const r of outRows) {
    const h = Number(localTime(new Date(r.occurredAt), tz).slice(0, 2));
    const i = DAY_PARTS.findIndex((p) => p.test(h));
    parts[i].amount += r.amount;
    parts[i].count++;
  }
  out.push(`Tiền ra theo buổi: ${parts.map((p) => `${p.label} ${vnd(p.amount)} (${p.count})`).join(', ')}.`);

  // Weekdays vs weekends, averaged over the covered days.
  let wdDays = 0;
  let weDays = 0;
  for (let d = c.firstDate; d <= today; d = addDays(d, 1)) {
    if (isWeekend(d)) weDays++;
    else wdDays++;
  }
  const wdOut = outRows.filter((r) => !isWeekend(r.localDate)).reduce((s, r) => s + r.amount, 0);
  const weOut = outRows.filter((r) => isWeekend(r.localDate)).reduce((s, r) => s + r.amount, 0);
  out.push(
    `Tiền ra ngày thường: ${vnd(wdOut)} (${wdDays} ngày, trung bình ${vnd(wdDays ? wdOut / wdDays : 0)}/ngày); ` +
      `cuối tuần: ${vnd(weOut)} (${weDays} ngày, trung bình ${vnd(weDays ? weOut / weDays : 0)}/ngày).`,
  );

  if (labels && labels.size > 0) {
    const cats = categoryBreakdown(snap, labels);
    out.push(
      `Nhóm chi (ước tính từ ghi chú): ${cats
        .map((x) => `${SPEND_CATEGORY_LABELS[x.key]} ${vnd(x.amount)} (${Math.round(x.share * 100)}%, ${x.count} giao dịch)`)
        .join(', ')}.`,
    );
  }

  const line = (r: TxnRangeRow) => {
    const note = r.note ? sanitize(r.note) : '';
    const cat = labels && r.direction === 'out' && r.note ? labels.get(normalizeNote(r.note)) : undefined;
    return `${r.localDate.slice(5)} ${localTime(new Date(r.occurredAt), tz)} | ${r.direction === 'in' ? 'vào' : 'ra'} | ${r.amount.toLocaleString('vi-VN')} | ${note}${cat ? ` [${SPEND_CATEGORY_LABELS[cat]}]` : ''}`;
  };

  const top = [...outRows].sort((a, b) => b.amount - a.amount).slice(0, TOP_SPENDS);
  out.push('', `${top.length} khoản chi lớn nhất:`, ...top.map(line));

  out.push('');
  if (rows.length <= FULL_LIST_LIMIT) {
    out.push('Tất cả giao dịch, mới nhất trước (ngày giờ | chiều | số tiền | ghi chú):', ...rows.map(line));
  } else {
    const noted = rows.filter((r) => r.note).slice(0, NOTED_LIST_LIMIT);
    const big = outRows.filter((r) => !r.note && r.amount >= BIG_UNNOTED_MIN).slice(0, BIG_UNNOTED_LIMIT);
    const picked = [...noted, ...big].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    out.push(
      `Danh sách dưới đây chỉ gồm giao dịch có ghi chú và khoản chi chưa ghi chú từ ${vnd(BIG_UNNOTED_MIN)} ` +
        `(${picked.length}/${rows.length} giao dịch). Dùng các con số tổng ở trên, không tự cộng danh sách này.`,
      '(ngày giờ | chiều | số tiền | ghi chú):',
      ...picked.map(line),
    );
    const byDay = new Map<string, { in: number; out: number }>();
    for (const r of rows) {
      const e = byDay.get(r.localDate) ?? { in: 0, out: 0 };
      e[r.direction] += r.amount;
      byDay.set(r.localDate, e);
    }
    out.push('', 'Tổng theo ngày (ngày: vào / ra):', ...[...byDay.entries()].map(([d, e]) => `${d}: ${vnd(e.in)} / ${vnd(e.out)}`));
  }

  out.push('DU_LIEU>>>');
  return out.join('\n');
}
