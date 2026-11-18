import type { CoupleDoc, DailyRewardPolicy } from '../models/Couple.js';
import { Couple } from '../models/Couple.js';
import { addDays, getLocalDate } from '../utils/date.js';
import { Errors } from '../utils/errors.js';

export interface RewardPolicyView { version: 1 | 2; effectiveDate: string; timezone: string }
/** Called only as part of creating a genuinely new Couple, in the same insert. */
export function newDailyRewardPolicy(timezone: string, now = new Date()): DailyRewardPolicy {
  return { version: 2, effectiveDate: getLocalDate(now, timezone), timezone, activatedAt: now };
}
export const rewardPolicyService = {
  /** Never infer newness from missing activity. Existing couples cut over tomorrow, exactly once. */
  async ensure(couple: CoupleDoc): Promise<DailyRewardPolicy> {
    if (couple.dailyRewardPolicy) return couple.dailyRewardPolicy;
    const now = new Date();
    const proposed: DailyRewardPolicy = { version: 2, effectiveDate: addDays(getLocalDate(now, couple.timezone), 1), timezone: couple.timezone, activatedAt: now };
    const winner = await Couple.findOneAndUpdate({ _id: couple._id, dailyRewardPolicy: null }, {
      $set: { dailyRewardPolicy: proposed },
    }, { new: true }).exec() ?? await Couple.findById(couple._id).exec();
    if (!winner?.dailyRewardPolicy) throw Errors.conflict('Chính sách thưởng đang được khởi tạo. Vui lòng thử lại.');
    couple.dailyRewardPolicy = winner.dailyRewardPolicy;
    return winner.dailyRewardPolicy;
  },
  async forDay(couple: CoupleDoc, localDate: string): Promise<RewardPolicyView> {
    const policy = await rewardPolicyService.ensure(couple);
    return { version: localDate >= policy.effectiveDate ? 2 : 1, effectiveDate: policy.effectiveDate, timezone: policy.timezone };
  },
};
