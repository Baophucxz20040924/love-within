import type { CoupleEvent } from '../../lib/types';

/**
 * "Thêm vào lịch điện thoại": an iCalendar file (RFC 5545) built on the phone, no API.
 * All-day events use DATE values; timed ones use the UTC instant the server computed in the couple timezone (startsAt),
 * so the phone shows the right local time wherever it is. UID is stable per event and date, so adding the same
 * occurrence twice updates it instead of duplicating it.
 */

const utf8 = new TextEncoder();

/** TEXT value escaping (§3.3.11): backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (§3.1); continuation lines start with one space. Never splits a UTF-8 character. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = utf8.encode(ch).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // the leading space counts
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const dateValue = (day: string) => day.replace(/-/g, '');

/** 2026-11-12T12:30:00.000Z → 20261112T123000Z */
const utcValue = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function buildIcs(ev: CoupleEvent, opts: { coupleId: string; now?: Date }): string {
  // Auto milestone ids ("auto-days-100") are the same for every couple; the couple id makes the UID unique.
  const uid = `${ev.auto ? `${opts.coupleId}-${ev.id}` : ev.id}-${dateValue(ev.nextDate)}@lookwithin`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Look Within//Su kien//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcValue(opts.now ?? new Date())}`,
  ];
  if (ev.startsAt) {
    const start = new Date(ev.startsAt);
    lines.push(`DTSTART:${utcValue(start)}`, `DTEND:${utcValue(new Date(start.getTime() + 3_600_000))}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateValue(ev.nextDate)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(ev.nextDate))}`);
  }
  // Yearly events repeat in the phone calendar too; 29/02 becomes "last day of February" (28/02 in non-leap years),
  // like the app. Auto anniversaries carry their year count in the title, so they stay single.
  if (ev.repeat === 'yearly' && !ev.auto) {
    lines.push(ev.date.slice(5) === '02-29' ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'RRULE:FREQ=YEARLY');
  }
  lines.push(`SUMMARY:${escapeIcsText(`${ev.emoji} ${ev.title}`)}`);
  if (ev.note) lines.push(`DESCRIPTION:${escapeIcsText(ev.note)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Save an .ics file; the phone offers to open it with its calendar app. */
export function saveIcsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One timed VEVENT in UTC (friends-space events, BB5): DTSTART/DTEND as UTC instants, folded and escaped like buildIcs. */
export function buildTimedIcs(ev: {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  cancelled?: boolean;
  now?: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Look Within//Keo//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${utcValue(ev.now ?? new Date())}`,
    `DTSTART:${utcValue(ev.start)}`,
    `DTEND:${utcValue(ev.end)}`,
    `SUMMARY:${escapeIcsText(ev.summary)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.cancelled) lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Save the .ics file; the phone offers to open it with its calendar app. */
export function downloadIcs(ev: CoupleEvent, coupleId: string): void {
  saveIcsFile(buildIcs(ev, { coupleId }), `su-kien-${ev.nextDate}.ics`);
}
