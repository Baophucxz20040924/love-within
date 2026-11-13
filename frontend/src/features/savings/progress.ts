/** Never round an unmet monetary target up to 100%. Keep signed/over-target values. */
export function savingsPercent(totalVnd: number, targetVnd: number): number {
  const percent = totalVnd / targetVnd * 100;
  return totalVnd >= 0 && totalVnd < targetVnd ? Math.floor(percent * 10) / 10 : percent;
}
