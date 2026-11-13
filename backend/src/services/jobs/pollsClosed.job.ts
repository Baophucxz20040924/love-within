import { friendStoryRepository } from '../../repositories/friendStory.repository.js';
import { logger } from '../../utils/logger.js';
import { notificationService } from '../notification.service.js';
import type { SchedulerJob } from '../scheduler.service.js';

// Job polls.closed (plan/FRIENDS_V2_PLAN.md BB6, plan/PLATFORM_PLAN.md N2): when the deadline of a poll in a friends post
// has passed, tell the post's author once ("Bình chọn của bạn đã kết thúc", notification poll_closed + push, group
// friends.social). Voters are not told (no push per vote either). Guard: the atomic flag poll.closedNotifiedAt (pattern a
// in scheduler.service.ts). Votes stop at the deadline itself (checked on every vote), not when this job runs.
// Deleted posts are skipped; a post hidden after reports is still announced (its author still sees it). The author
// replacing the deadline (only possible without votes) resets the flag. Always catches up after downtime.

/** Polls announced per run; more wait for the next run. */
const BATCH = 200;

export const pollsClosedJob: SchedulerJob = {
  name: 'polls.closed',
  everyMin: 5,
  async run(now) {
    const ids = await friendStoryRepository.listPollsToAnnounce(now, BATCH);
    let sent = 0;
    for (const id of ids) {
      const story = await friendStoryRepository.markPollClosedNotified(id, now);
      // null: another run took it, or the post was deleted or its poll replaced a moment ago.
      if (!story) continue;
      logger.debug('Friend poll closed', { userId: story.authorId.toString(), storyId: story._id.toString() });
      await notificationService.emit({ space: 'friends', to: story.authorId, type: 'poll_closed', actorId: null, entityId: story._id });
      sent += 1;
    }
    return sent;
  },
};
