import { formatDate, formatDay, formatNumber, formatTime } from '../../lib/format';

/** "còn 96 ngày" · "ngày mai" (sealed letters only: daysLeft ≥ 1). */
export function sealedLeft(daysLeft: number): string {
  return daysLeft <= 1 ? 'ngày mai' : `còn ${formatNumber(daysLeft)} ngày`;
}

/** "Thư từ Hà · mở vào 14/02/2027 · còn 96 ngày" */
export function sealedLine(fromName: string, openOn: string, daysLeft: number): string {
  return `Thư từ ${fromName} · mở vào ${formatDay(openOn)} · ${sealedLeft(daysLeft)}`;
}

/** "08:12 14/02/2027" (device time). */
export function openedWhen(iso: string): string {
  return `${formatTime(iso)} ${formatDate(iso)}`;
}
