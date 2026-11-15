import { realtimeAudience } from '../realtimeAudience.service.js';
import type { Types } from 'mongoose';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { momentRepository, type NewMomentDay } from '../../repositories/moment.repository.js';
import { addDays, getLocalDate } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { newMomentDay } from '../moment.service.js';
import { notificationService } from '../notification.service.js';
import type { SchedulerJob } from '../scheduler.service.js';

// Every minute: persist missing daily schedules, then claim only prompts still within their reward window.
const COUPLES_PER_PAGE = 200;
/** Safety bound: 100 pages = 20 000 couples per run; more are created by the next runs. */
const MAX_PAGES = 100;
/** Prompts announced per run; more wait for the next minute. */
const NOTIFY_BATCH = 200;

/** Lock-screen text of the prompt (plan wording). */
export const PROMPT_BODY = 'Khoảnh khắc hôm nay đã mở. Cả hai chụp trước hạn thưởng để cùng nhận 40 Xu!';

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
  const ids = await momentRepository.listDueToNotify(days, now, NOTIFY_BATCH);
  let sent = 0;
  for (const { id, sessionId } of ids) {
    const m = await momentRepository.markNotified(id, sessionId);
    // null: another run took it a moment ago.
    if (!m) continue;
    await realtimeAudience.couple(m.coupleId, ['moments']);
    const couple = await coupleRepository.findById(m.coupleId);
    if (!couple || couple.status !== 'active') continue;
    const session = m.sessions!.find((s) => s.id === sessionId)!;
    const posted = new Set(session.posts.map((p) => p.userId.toString()));
    for (const to of couple.memberIds) {
      if (posted.has(to.toString()) || !session.rewardEndsAt || new Date() >= session.rewardEndsAt) continue;
      await notificationService.emit({
        space: 'couple',
        to,
        actorId: null,
        type: 'moment_prompt',
        entityId: m._id,
        push: { body: PROMPT_BODY, url: `/moments?date=${m.localDate}&session=${sessionId}`, tag: `moment:${m.localDate}:${sessionId}`, expiresAt: session.rewardEndsAt.toISOString() },
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
