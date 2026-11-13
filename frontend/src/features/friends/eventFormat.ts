import { buildTimedIcs, saveIcsFile } from '../events/ics';
import type { FriendEvent, RsvpStatus } from '../../lib/types';

/**
 * "Lên kèo" (BB5): the server stores UTC; everything here is shown in the phone's own timezone (Intl without timeZone).
 */

const HOUR_MS = 3_600_000;
/** No end time: the calendar entry lasts 2 hours (the app treats the event as over 6 hours after the start). */
const ICS_DEFAULT_MS = 2 * HOUR_MS;

const weekdayFmt = new Intl.DateTimeFormat('vi-VN', { weekday: 'short' });
const dayMonthFmt = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');

/** "T7, 14/11" */
export function dayLabel(d: Date): string {
  return `${weekdayFmt.format(d)}, ${dayMonthFmt.format(d)}`;
}

/** "19:30" */
export function timeLabel(d: Date): string {
  return timeFmt.format(d);
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "T7, 14/11 · 19:30 – 22:30", or "T7, 14/11 · 19:30 → CN, 15/11 · 10:00" across days. */
export function whenLabel(ev: Pick<FriendEvent, 'startAt' | 'endAt'>): string {
  const start = new Date(ev.startAt);
  const head = `${dayLabel(start)} · ${timeLabel(start)}`;
  if (!ev.endAt) return head;
  const end = new Date(ev.endAt);
  return sameDay(start, end) ? `${head} – ${timeLabel(end)}` : `${head} → ${dayLabel(end)} · ${timeLabel(end)}`;
}

/** Date tile of a card: { day: "14", month: "Th11" }. */
export function dateTile(iso: string): { day: string; month: string } {
  const d = new Date(iso);
  return { day: String(d.getDate()), month: `Th${d.getMonth() + 1}` };
}

/** "Hôm nay", "Ngày mai", "Còn 3 ngày", "Còn 2 giờ", "Đang diễn ra", "Đã qua", "Đã hủy". */
export function statusLabel(ev: Pick<FriendEvent, 'startAt' | 'past' | 'status'>, now = Date.now()): string {
  if (ev.status === 'cancelled') return 'Đã hủy';
  if (ev.past) return 'Đã qua';
  const start = new Date(ev.startAt);
  const diff = start.getTime() - now;
  if (diff <= 0) return 'Đang diễn ra';
  if (diff < HOUR_MS) return `Còn ${Math.max(1, Math.round(diff / 60_000))} phút`;
  const today = new Date(now);
  if (sameDay(start, today)) return diff < 6 * HOUR_MS ? `Còn ${Math.round(diff / HOUR_MS)} giờ` : 'Hôm nay';
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (sameDay(start, tomorrow)) return 'Ngày mai';
  const days = Math.round((new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  return `Còn ${days} ngày`;
}

export const RSVP_LABEL: Record<RsvpStatus, string> = { going: 'Đi', maybe: 'Có thể', declined: 'Không đi' };

/** "Đi 5 · Có thể 2 · Chưa trả lời 3 · Không đi 1" (zero groups left out, "Đi" always shown). */
export function countsLabel(c: FriendEvent['counts']): string {
  const parts = [`Đi ${c.going}`];
  if (c.maybe) parts.push(`Có thể ${c.maybe}`);
  if (c.pending) parts.push(`Chưa trả lời ${c.pending}`);
  if (c.declined) parts.push(`Không đi ${c.declined}`);
  return parts.join(' · ');
}

/** The map link, or a map search for the place text; null when there is neither. */
export function mapHref(ev: Pick<FriendEvent, 'mapUrl' | 'place'>): string | null {
  if (ev.mapUrl) return ev.mapUrl;
  if (ev.place.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.place.trim())}`;
  return null;
}

/** The .ics text of an event, in UTC (DTSTART/DTEND …Z), so the phone shows it at its own local time. */
export function eventIcs(ev: FriendEvent, now = new Date()): string {
  const start = new Date(ev.startAt);
  const end = ev.endAt ? new Date(ev.endAt) : new Date(start.getTime() + ICS_DEFAULT_MS);
  return buildTimedIcs({
    uid: `keo-${ev.id}@lookwithin`,
    start,
    end,
    summary: ev.title,
    location: ev.place || undefined,
    description: ev.description || undefined,
    cancelled: ev.status === 'cancelled',
    now,
  });
}

export function downloadEventIcs(ev: FriendEvent): void {
  saveIcsFile(eventIcs(ev), `keo-${new Date(ev.startAt).toISOString().slice(0, 10)}.ics`);
}

/** Device-local "YYYY-MM-DD" and "HH:mm" of an instant (for date and time inputs). */
export function toLocalInputs(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** Date and time inputs (device-local) → UTC ISO, or null when incomplete. */
export function fromLocalInputs(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const local = new Date(y, m - 1, d, h, min, 0, 0);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

/** "nguyen thu ha": search without case and Vietnamese diacritics (same as the server). */
export function plainName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
