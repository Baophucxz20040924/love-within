// Vietnamese-locale formatting helpers (thousands separator ".", dd/mm/yyyy, relative time).

const numberFmt = new Intl.NumberFormat('vi-VN');
const relativeFmt = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });

export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

export function formatMl(n: number): string {
  return `${numberFmt.format(n)} ml`;
}

/** dd/mm/yyyy in the given IANA timezone (defaults to the device timezone). */
export function formatDate(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(
    new Date(iso),
  );
}

/** HH:mm */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "Thứ Năm, 5 tháng 11" */
export function formatToday(date = new Date()): string {
  const s = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  return s.charAt(0).toLocaleUpperCase('vi') + s.slice(1);
}

/** "vừa xong", "5 phút trước", "hôm qua"… */
export function timeAgo(iso: string, now = Date.now()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'vừa xong';
  if (abs < 3600) return relativeFmt.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return relativeFmt.format(Math.round(diffSec / 3600), 'hour');
  return relativeFmt.format(Math.round(diffSec / 86_400), 'day');
}

/** Given name for greetings: Vietnamese names put it last ("Nguyễn Thu Hà" → "Hà"). */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || displayName;
}

/** "YYYY-MM-DD" of an instant in an IANA timezone. */
export function localDateOf(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    typeof iso === 'string' ? new Date(iso) : iso,
  );
}

/** dd/mm/yyyy for a calendar day stored as "YYYY-MM-DD" (no timezone shift). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

/** "dd/mm/yyyy lúc HH:mm" — used in tooltips (e.g. when a post was edited). */
export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} lúc ${formatTime(iso)}`;
}

// ── Money (VND) ──────────────────────────────────────────

/** 125000 → "125.000đ" */
export function formatVnd(n: number): string {
  return `${numberFmt.format(n)}đ`;
}

/** Transaction amount with its direction: "+125.000đ" / "−50.000đ" (true minus sign). */
export function formatSignedVnd(direction: 'in' | 'out', amount: number): string {
  return `${direction === 'in' ? '+' : '−'}${formatVnd(amount)}`;
}

/** Net balance of a period: "+20.000đ", "−5.000đ" or "0đ". */
export function formatNetVnd(n: number): string {
  if (n === 0) return formatVnd(0);
  return `${n > 0 ? '+' : '−'}${formatVnd(Math.abs(n))}`;
}

// ── Calendar months / days ("YYYY-MM", "YYYY-MM-DD", no timezone shift) ──

/** "2026-11" → "Tháng 11/2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

/** "2026-01" shifted by -1 → "2025-12". */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** "Hôm nay" / "Hôm qua" / "Thứ Năm, 05/11" (year added when it differs from today's). */
export function dayHeading(day: string, today: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = today.split('-').map(Number);
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - t) / 86_400_000);
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(t));
  const label = `${weekday.charAt(0).toLocaleUpperCase('vi')}${weekday.slice(1)}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  return y === ty ? label : `${label}/${y}`;
}
