import { formatNumber } from '../../lib/format';
import type { EventKind, EventRepeat } from '../../lib/types';

export const MAX_EVENT_TITLE = 80;
export const MAX_EVENT_NOTE = 500;
/** Same range as the server (birthdays reach far back). */
export const EVENT_DATE_MIN = '1900-01-01';
export const EVENT_DATE_MAX = '2100-12-31';

export const EVENT_KINDS: { value: EventKind; label: string; emoji: string }[] = [
  { value: 'birthday', label: 'Sinh nhật', emoji: '🎂' },
  { value: 'trip', label: 'Chuyến đi', emoji: '✈️' },
  { value: 'meet', label: 'Gặp nhau', emoji: '🤗' },
  { value: 'anniversary', label: 'Kỷ niệm', emoji: '💞' },
  { value: 'other', label: 'Khác', emoji: '📌' },
];

export const kindInfo = (kind: EventKind) => EVENT_KINDS.find((k) => k.value === kind) ?? EVENT_KINDS[4];

/** Emoji choices in the form (the kind's default comes first when it is picked). */
export const EVENT_EMOJIS = ['🎂', '✈️', '🤗', '💞', '📌', '🎉', '🏖️', '🍰', '💍', '🎁'];

/** Repeat on by default for birthdays and anniversaries (same rule as the server). */
export const defaultRepeat = (kind: EventKind): EventRepeat => (kind === 'birthday' || kind === 'anniversary' ? 'yearly' : 'none');

/** "Hôm nay" · "Ngày mai" · "còn 12 ngày" · "Hôm qua" · "3 ngày trước". */
export function daysLeftText(n: number): string {
  if (n === 0) return 'Hôm nay';
  if (n === 1) return 'Ngày mai';
  if (n > 1) return `còn ${formatNumber(n)} ngày`;
  if (n === -1) return 'Hôm qua';
  return `${formatNumber(-n)} ngày trước`;
}

/** "Thứ Hai, 23/11/2026" for a calendar day "YYYY-MM-DD" (no timezone shift). */
export function eventDayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${weekday.charAt(0).toLocaleUpperCase('vi')}${weekday.slice(1)}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

/** Whole days, hours and minutes left (minutes rounded up, so "1 phút" shows until the moment itself). */
export function countdownParts(ms: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.ceil(ms / 60_000));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}
