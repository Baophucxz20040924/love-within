import { formatNumber } from '../../lib/format';
import { MAX_LETTER_YEARS } from './api';

// Calendar days "YYYY-MM-DD" (no timezone shift), same rules as the server (backend/src/utils/date.ts).

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The day a yearly date falls on in `year` (29/02 → 28/02 in non-leap years). */
export function yearlyIn(base: string, year: number): string {
  const md = base.slice(5);
  const y = String(year).padStart(4, '0');
  return md === '02-29' && !isLeap(year) ? `${y}-02-28` : `${y}-${md}`;
}

/** Next yearly occurrence strictly after today (a letter cannot open today). */
export function nextYearlyAfter(base: string, today: string): string {
  if (base > today) return base;
  const year = Number(today.slice(0, 4));
  const thisYear = yearlyIn(base, year);
  return thisYear > today ? thisYear : yearlyIn(base, year + 1);
}

/** Open dates the server accepts: tomorrow … the same day in 20 years. */
export function openRange(today: string): { min: string; max: string } {
  return { min: addDays(today, 1), max: yearlyIn(today, Number(today.slice(0, 4)) + MAX_LETTER_YEARS) };
}

export function inOpenRange(day: string, today: string): boolean {
  const { min, max } = openRange(today);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= min && day <= max;
}

export interface QuickPick {
  key: string;
  label: string;
  date: string;
}

interface PickSources {
  today: string;
  partnerName: string;
  /** Stored date (birth date) of the partner's birthday event (CP4), if any. */
  partnerBirthday: string | null;
  /** Next love milestone from the couple (days, remaining). */
  nextMilestone: { days: number; remaining: number } | null;
  /** Day the couple started, couple timezone. */
  anniversaryDay: string | null;
}

/** Quick picks for the open date: partner's birthday, next love milestone, next anniversary, next 14/02, one year from now. */
export function quickPicks(s: PickSources): QuickPick[] {
  const year = Number(s.today.slice(0, 4));
  const picks: QuickPick[] = [];
  if (s.partnerBirthday) {
    picks.push({ key: 'birthday', label: `Sinh nhật ${s.partnerName}`, date: nextYearlyAfter(s.partnerBirthday, s.today) });
  }
  if (s.nextMilestone && s.nextMilestone.remaining > 0) {
    picks.push({
      key: 'milestone',
      label: `Tròn ${formatNumber(s.nextMilestone.days)} ngày yêu nhau`,
      date: addDays(s.today, s.nextMilestone.remaining),
    });
  }
  if (s.anniversaryDay) {
    const date = nextYearlyAfter(s.anniversaryDay, s.today);
    const years = Number(date.slice(0, 4)) - Number(s.anniversaryDay.slice(0, 4));
    if (years > 0) picks.push({ key: 'anniversary', label: `Kỷ niệm ${years} năm`, date });
  }
  picks.push({ key: 'valentine', label: 'Valentine 14/02', date: nextYearlyAfter(`${year}-02-14`, s.today) });
  picks.push({ key: 'year', label: '1 năm nữa', date: yearlyIn(s.today, year + 1) });

  const seen = new Set<string>();
  return picks.filter((p) => {
    if (!inOpenRange(p.date, s.today) || seen.has(p.date)) return false;
    seen.add(p.date);
    return true;
  });
}
