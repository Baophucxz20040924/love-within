/**
 * Centralized in-app economy configuration.
 * All coin/EXP rewards and level thresholds live here — never hard-coded elsewhere.
 */
export const ECONOMY = {
  dailyRewards: {
    checkinBase: 5, checkinStreakPerDay: 1, checkinExp: 5,
    momentPhoto: 10, momentTimelyPair: 10,
    quest: { coin: 0, exp: 5 },
  },
  checkin: {
    coin: 10,
    exp: 5,
    streakBonusPerDay: 2, // extra coin per consecutive day
    streakCap: 50, // max bonus coin from streak
  },
  quests: {
    // Per-quest overrides keyed by quest.key. Falls back to the quest doc's own reward.
    drink_water: { coin: 20, exp: 15 },
    daily_checkin: { coin: 10, exp: 5 },
    // Both members answer today's question on the day (CP1). Late answers give nothing.
    daily_question: { coin: 10, exp: 10 },
    // Both members post within the daily 30-minute reward window; split between personal wallets.
    duo_moment: { coin: 40, exp: 5 },
  } as Record<string, { coin: number; exp: number }>,
  // Existing flat/v2 days retain their original reward; stored intents always take precedence.
  legacyDuoMoment: { coin: 10, exp: 5 },
  /**
   * Bucket list (CP3, owner decision 10/11/2026): reward per item, once ever. The item must have been created at least
   * `minAgeHours` before it is marked done, and at most `maxRewardsPerDay` items are rewarded per couple-timezone day.
   */
  bucket: { coin: 30, exp: 20, minAgeHours: 24, maxRewardsPerDay: 2 },
  /**
   * Cumulative EXP required to reach each level.
   * Index 0 = level 1 (0 EXP), index 1 = level 2 (100 EXP), etc.
   */
  levels: [0, 100, 250, 500, 900, 1500, 2300, 3300, 4600, 6200],
} as const;

/** Resolve a couple's level from its cumulative EXP. */
export function levelFromExp(exp: number): number {
  let level = 1;
  for (let i = 0; i < ECONOMY.levels.length; i++) {
    if (exp >= ECONOMY.levels[i]) {
      level = i + 1;
    } else {
      break;
    }
  }
  return level;
}
