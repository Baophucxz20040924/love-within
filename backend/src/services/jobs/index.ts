import { registerJob } from '../scheduler.service.js';
import { coupleEventsRemindJob } from './coupleEventsRemind.job.js';
import { duoMomentPromptJob } from './duoMomentPrompt.job.js';
import { friendEventsRemindJob } from './friendEventsRemind.job.js';
import { lettersReadyJob } from './lettersReady.job.js';
import { pollsClosedJob } from './pollsClosed.job.js';

/**
 * Register every background job (plan/OPERATIONS.md, N2). Called once at app startup (createApp), so the loop and the
 * dev endpoint see the same jobs. A new feature adds its job here.
 */
export function registerAllJobs(): void {
  registerJob(lettersReadyJob);
  registerJob(coupleEventsRemindJob);
  registerJob(pollsClosedJob);
  registerJob(friendEventsRemindJob);
  registerJob(duoMomentPromptJob);
}
