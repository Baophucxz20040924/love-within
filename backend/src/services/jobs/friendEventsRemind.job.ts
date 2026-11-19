import { Types } from 'mongoose';
import { friendEventRepository, type RemindableFriendEvent } from '../../repositories/friendEvent.repository.js';
import { friendshipRepository } from '../../repositories/friendship.repository.js';
import { friendBlockRepository } from '../../repositories/friendSafety.repository.js';
import { logger } from '../../utils/logger.js';
import { notificationService } from '../notification.service.js';
import { alreadySent, claimSend, type SchedulerJob } from '../scheduler.service.js';

// Job friend-events.remind (plan/ENGINEERING_WORKFLOW.md BB5, plan/OPERATIONS.md N2), every 5 minutes: 2 hours before an
// active event starts, remind the creator and the invitees who answered Đi or Có thể (not "Không đi", not people who did
// not answer, not people who are no longer friends of the creator; only the creator for an event hidden after reports).
// Notification event_reminder (no actor) + push, group friends.events, TTL 4 h.
// Guard: claimSend(`bb-event:<id>:<startAt ISO>:h2`) (pattern b in scheduler.service.ts). The start time is in the key,
// so a new start time re-arms the reminder. Bounded catch-up: only events that have not started yet (startAt > now);
// a server that was down past the start sends nothing for it. Cancelled and deleted events are skipped.

const WINDOW_MS = 2 * 3_600_000;
/** Candidate budget, including already-claimed events. Continuation is process-local, not delivery state. */
const BATCH = 500;
let continuation: { startAt: Date; id: Types.ObjectId } | undefined;
let activeRun: Promise<number> | null = null;

export function friendEventReminderKey(eventId: Types.ObjectId | string, startAt: Date): string {
  return `bb-event:${eventId.toString()}:${startAt.toISOString()}:h2`;
}

/** Creator first, then Đi / Có thể invitees who are still friends of the creator. */
export function reminderRecipients(ev: RemindableFriendEvent, creatorFriends: ReadonlySet<string>): Types.ObjectId[] {
  const out = [ev.creatorId];
  if (ev.hiddenByReportsAt) return out;
  const answers = ev.rsvps ?? {};
  for (const id of ev.inviteeIds) {
    const key = id.toString();
    const a = answers[key];
    if ((a === 'going' || a === 'maybe') && creatorFriends.has(key)) out.push(id);
  }
  return out;
}

async function runReminderPage(now: Date): Promise<number> {
  const events = await friendEventRepository.listStartingBetween(now, new Date(now.getTime() + WINDOW_MS), BATCH, continuation);
  if (events.length === 0) { continuation = undefined; return 0; }
  if (events.length >= BATCH) logger.warn('Friend event reminders: batch cut at the limit', { batch: BATCH });
  const keys = events.map((e) => friendEventReminderKey(e._id, e.startAt));
  const done = await alreadySent(keys);
  const friendsOf = new Map<string, Set<string>>();
  let sent = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const key = keys[i];
    if (done.has(key) || !(await claimSend(key))) {
      continuation = { startAt: ev.startAt, id: ev._id };
      continue;
    }
    const creator = ev.creatorId.toString();
    let friends = friendsOf.get(creator);
    if (!friends) {
      friends = new Set((await friendshipRepository.friendIds(ev.creatorId)).map((id) => id.toString()));
      friendsOf.set(creator, friends);
    }
    const to = reminderRecipients(ev, friends);
    logger.debug('Friend event reminder due', { eventId: ev._id.toString(), recipients: to.length, key });
    for (const userId of to) {
      // System notifications have no actor, so independently enforce the creator's block boundary.
      if (!userId.equals(ev.creatorId) && await friendBlockRepository.isBlockedBetween(userId, ev.creatorId)) continue;
      await notificationService.emit({ space: 'friends', to: userId, type: 'event_reminder', actorId: null, entityId: ev._id });
    }
    sent += 1;
    continuation = { startAt: ev.startAt, id: ev._id };
  }
  if (events.length < BATCH) continuation = undefined;
  return sent;
}

export const friendEventsRemindJob: SchedulerJob = {
  name: 'friend-events.remind',
  everyMin: 5,
  run(now) {
    if (activeRun) return activeRun;
    const run = runReminderPage(now);
    activeRun = run;
    const clear = () => { if (activeRun === run) activeRun = null; };
    void run.then(clear, clear);
    return run;
  },
};
