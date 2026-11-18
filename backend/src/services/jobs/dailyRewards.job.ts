import type { Types } from 'mongoose';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { dailyRewardService } from '../dailyReward.service.js';
import { momentEffectsService } from '../momentEffects.service.js';
import type { SchedulerJob } from '../scheduler.service.js';
import { logger } from '../../utils/logger.js';

// A rotating bounded page prevents an offline couple's old source receipts from being forgotten.
let after: Types.ObjectId | null = null;
export const dailyRewardsJob: SchedulerJob = {
  name: 'daily-rewards.recover', everyMin: 1,
  async run() {
    let couples = await coupleRepository.listActivePage(after, 20);
    if (!couples.length && after) {
      after = null;
      couples = await coupleRepository.listActivePage(null, 20);
    }
    for (const couple of couples) {
      after = couple._id;
      try { await dailyRewardService.recoverCouple(couple, 20); }
      catch { logger.warn('Daily reward recovery pending retry'); }
    }
    return momentEffectsService.recover(undefined, 20);
  },
};
