import { formatDay, formatNumber } from '../../lib/format';
import type { BucketCategory } from '../../lib/types';

export const MAX_BUCKET_TITLE = 120;
export const MAX_BUCKET_NOTE = 1000;
export const MAX_BUCKET_PHOTOS = 10;
/** Same range as the server. */
export const BUCKET_DATE_MAX = '2100-12-31';

/** Same as the server (backend/src/models/BucketItem.ts); also returned by GET /api/bucket/ideas. */
export const BUCKET_CATEGORIES: { value: BucketCategory; label: string; emoji: string }[] = [
  { value: 'travel', label: 'Du lịch', emoji: '✈️' },
  { value: 'food', label: 'Ăn uống', emoji: '🍜' },
  { value: 'experience', label: 'Trải nghiệm', emoji: '🎢' },
  { value: 'learning', label: 'Học cùng nhau', emoji: '📚' },
  { value: 'other', label: 'Khác', emoji: '✨' },
];

export const categoryInfo = (c: BucketCategory) => BUCKET_CATEGORIES.find((x) => x.value === c) ?? BUCKET_CATEGORIES[4];

/** Emoji choices in the form (the category's default comes first). */
export const BUCKET_EMOJIS = ['✈️', '🍜', '🎢', '📚', '✨', '🏖️', '⛺', '🎬', '🎨', '💞'];

/** Due date line: "Hạn 23/11/2026 · còn 12 ngày", "Hạn hôm nay", "Quá hạn 3 ngày". */
export function dueText(dueOn: string, today: string): { text: string; late: boolean } {
  const days = Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return { text: 'Hạn hôm nay', late: false };
  if (days === 1) return { text: 'Hạn ngày mai', late: false };
  if (days > 1) return { text: `Hạn ${formatDay(dueOn)} · còn ${formatNumber(days)} ngày`, late: false };
  return { text: `Quá hạn ${formatNumber(-days)} ngày`, late: true };
}
