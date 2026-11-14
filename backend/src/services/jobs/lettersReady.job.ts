import type { CoupleLetterDoc } from '../../models/CoupleLetter.js';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { letterRepository } from '../../repositories/letter.repository.js';
import { logger } from '../../utils/logger.js';
import { notificationService } from '../notification.service.js';
import type { SchedulerJob } from '../scheduler.service.js';

// Job letters.ready (plan/ENGINEERING_WORKFLOW.md CP2, plan/OPERATIONS.md N2): a timed letter whose open time has come is
// announced to its recipient once. Guard: the atomic flag readyNotifiedAt on the letter (pattern a in scheduler.service.ts).
// The author moving the open date resets the flag (letter.repository.ts updateContent), so the new date is announced again.
// Letters that are opened or deleted before the job sees them are never announced. Always catches up after downtime.

/** Letters announced per run; more wait for the next minute. */
const BATCH = 200;

/**
 * Tell the recipient that the letter can be opened now (push, group couple.stories). Called once per letter (and again
 * after a new open date). Never the title or the body. A couple that is no longer active (unpaired) gets nothing; the
 * flag stays set, so the letter is not tried again.
 */
export async function deliverLetterReady(letter: CoupleLetterDoc): Promise<void> {
  const ids = { coupleId: letter.coupleId.toString(), userId: letter.recipientId.toString(), letterId: letter._id.toString() };
  const couple = await coupleRepository.findById(letter.coupleId);
  if (!couple || couple.status !== 'active' || !couple.memberIds.some((m) => m.equals(letter.recipientId))) {
    logger.debug('Letter came due in an inactive couple: no push', ids);
    return;
  }
  logger.debug('Letter ready to open', ids);
  const id = letter._id.toString();
  await notificationService.emit({
    space: 'couple',
    to: letter.recipientId,
    actorId: letter.authorId,
    type: 'letter_ready',
    entityId: letter._id,
    push: { body: (name) => `Có một lá thư từ ${name} đang chờ bạn mở 💌`, url: `/letters/${id}`, tag: `letter:${id}` },
  });
}

export const lettersReadyJob: SchedulerJob = {
  name: 'letters.ready',
  everyMin: 1,
  async run(now) {
    const ids = await letterRepository.listReadyToAnnounce(now, BATCH);
    let sent = 0;
    for (const id of ids) {
      const letter = await letterRepository.markReadyNotified(id, now);
      // null: another run took it, or it was opened, moved or deleted a moment ago.
      if (!letter) continue;
      await deliverLetterReady(letter);
      sent += 1;
    }
    return sent;
  },
};
