/**
 * Return the local calendar date ("YYYY-MM-DD") for a given instant in an IANA timezone.
 * Used for all "within the day" logic (check-in, water, quests) so both couple members
 * share the same day boundary regardless of their device timezone.
 */
export function getLocalDate(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD.
  return fmt.format(date);
}

/** Local wall-clock time "HH:mm" (24 h) of an instant in an IANA timezone. */
export function getLocalTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** "YYYY-MM-DD" → "dd/mm/yyyy" (Vietnamese order, no timezone math). */
export function formatDayVi(localDate: string): string {
  return `${localDate.slice(8, 10)}/${localDate.slice(5, 7)}/${localDate.slice(0, 4)}`;
}

/** Whole days elapsed between an anniversary date and "now" in the couple timezone. */
export function daysBetween(anniversary: Date, timezone: string, now = new Date()): number {
  const a = getLocalDate(anniversary, timezone);
  const b = getLocalDate(now, timezone);
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000);
}

/** Shift a "YYYY-MM-DD" local date by n days (calendar arithmetic, timezone-free). */
export function addDays(localDate: string, n: number): string {
  const t = Date.parse(`${localDate}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** True for a real calendar day "YYYY-MM-DD" (rejects "2026-02-30" and "2027-02-29"). */
export function isRealDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The day a yearly date ("YYYY-MM-DD") falls on in `year`. 29/02 falls on 28/02 in non-leap years. */
export function yearlyDateIn(base: string, year: number): string {
  const monthDay = base.slice(5);
  const y = String(year).padStart(4, '0');
  return monthDay === '02-29' && !isLeapYear(year) ? `${y}-02-28` : `${y}-${monthDay}`;
}

/**
 * Next occurrence of a yearly date on or after `today` (both "YYYY-MM-DD", same timezone). Never earlier than
 * `base` itself, so a yearly event created for a future first date starts on that date.
 */
export function nextYearlyDate(base: string, today: string): string {
  if (base >= today) return base;
  const year = Number(today.slice(0, 4));
  const thisYear = yearlyDateIn(base, year);
  return thisYear >= today ? thisYear : yearlyDateIn(base, year + 1);
}

/** Calendar days from `from` to `to` ("YYYY-MM-DD"); negative when `to` is earlier. */
export function daysUntil(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Offset of `timeZone` from UTC at `instant`, in ms (UTC+7 → +25 200 000). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time ("HH:mm") on a local date in an IANA timezone, e.g. a "meet" event at 19:30
 * couple time. DST: a time that occurs twice gives the first one; a time skipped by a spring-forward gap gives the
 * instant one hour later on the clock (02:30 → 03:30).
 */
export function zonedTimeToUtc(localDate: string, time: string, timeZone: string): Date {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - zoneOffsetMs(wall, timeZone);
  const offset = zoneOffsetMs(first, timeZone);
  if (wall - first === offset) return new Date(first);
  const second = wall - offset;
  return new Date(zoneOffsetMs(second, timeZone) === offset ? second : Math.max(first, second));
}
