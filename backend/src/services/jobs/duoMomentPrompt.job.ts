import type { Types } from 'mongoose';
import { MOMENT_NOTIFY_MAX_LATE_MIN } from '../../models/DuoMoment.js';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { momentRepository, type NewMomentDay } from '../../repositories/moment.repository.js';
import { addDays, getLocalDate } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { newMomentDay } from '../moment.service.js';
import { notificationService } from '../notification.service.js';
import type { SchedulerJob } from '../scheduler.service.js';

// Job duo-moment.prompt (plan/COUPLE_V2_PLAN.md CP6, plan/PLATFORM_PLAN.md N2), every minute:
// 1. Create today's moment (couple timezone) for every active couple that has none yet, with a random prompt time in
//    09:00–21:00 (moment.service.ts newMomentDay; crypto RNG). Upserts on the unique (coupleId, localDate) index, so a
//    second run, or a member opening the app at the same moment (lazy "today"), never makes a second moment or a second
//    time. In practice only the first run after midnight of each timezone creates anything.
// 2. Announce prompts whose time has come, at most 30 minutes late: notifiedAt null → now (pattern a in
//    scheduler.service.ts), then push both members who have not posted yet. A prompt more than 30 minutes old (server
//    down) is never announced: the Home card still shows the open moment.

const COUPLES_PER_PAGE = 200;
/** Safety bound: 100 pages = 20 000 couples per run; more are created by the next runs. */
const MAX_PAGES = 100;
/** Prompts announced per run; more wait for the next minute. */
const NOTIFY_BATCH = 200;
const MAX_LATE_MS = MOMENT_NOTIFY_MAX_LATE_MIN * 60_000;

/** Lock-screen text of the prompt (plan wording). */
export const PROMPT_BODY = '📸 Đến giờ Khoảnh khắc! Chụp trong 10 phút để đúng giờ';

async function createMissingDays(now: Date): Promise<number> {
  let after: Types.ObjectId | null = null;
  let created = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const couples = await coupleRepository.listActivePage(after, COUPLES_PER_PAGE);
    if (couples.length === 0) break;
    after = couples[couples.length - 1]._id;
    const pairs = couples.map((c) => ({ couple: c, coupleId: c._id, localDate: getLocalDate(now, c.timezone) }));
    const existing = await momentRepository.existingDays(pairs);
    const missing: NewMomentDay[] = pairs
      .filter((p) => !existing.has(`${p.coupleId.toString()}|${p.localDate}`))
      .map((p) => newMomentDay(p.coupleId, p.localDate, p.couple.timezone, now));
    created += await momentRepository.createDays(missing);
    if (couples.length < COUPLES_PER_PAGE) break;
    if (page === MAX_PAGES - 1) logger.warn('Duo moments: couple pages cut at the limit', { pages: MAX_PAGES });
  }
  return created;
}

async function announceDue(now: Date): Promise<number> {
  // Every timezone's "today" lies within a day of the UTC date.
  const utcToday = getLocalDate(now, 'UTC');
  const days = [addDays(utcToday, -1), utcToday, addDays(utcToday, 1)];
  const ids = await momentRepository.listDueToNotify(days, now, MAX_LATE_MS, NOTIFY_BATCH);
  let sent = 0;
  for (const id of ids) {
    const m = await momentRepository.markNotified(id, now, MAX_LATE_MS);
    // null: another run took it a moment ago.
    if (!m) continue;
    const couple = await coupleRepository.findById(m.coupleId);
    if (!couple || couple.status !== 'active') continue;
    const posted = new Set(m.posts.map((p) => p.userId.toString()));
    for (const to of couple.memberIds) {
      if (posted.has(to.toString())) continue;
      await notificationService.emit({
        space: 'couple',
        to,
        actorId: null,
        type: 'moment_prompt',
        entityId: m._id,
        push: { body: PROMPT_BODY, url: '/moments', tag: `moment:${m.localDate}` },
      });
    }
    logger.debug('Duo moment prompt announced', { coupleId: m.coupleId.toString(), localDate: m.localDate });
    sent += 1;
  }
  return sent;
}

export const duoMomentPromptJob: SchedulerJob = {
  name: 'duo-moment.prompt',
  everyMin: 1,
  async run(now) {
    const created = await createMissingDays(now);
    const announced = await announceDue(now);
    return created + announced;
  },
};
