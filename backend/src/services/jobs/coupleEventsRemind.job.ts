import { realtimeAudience } from '../realtimeAudience.service.js';
import { Types } from 'mongoose';
import type { CoupleDoc } from '../../models/Couple.js';
import type { EventRepeat } from '../../models/CoupleEvent.js';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { eventRepository, type RemindableEvent } from '../../repositories/event.repository.js';
import { addDays, getLocalDate, nextYearlyDate, zonedTimeToUtc } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { autoMilestones } from '../event.service.js';
import { notificationService } from '../notification.service.js';
import { alreadySent, claimSend, type SchedulerJob } from '../scheduler.service.js';

// Job couple-events.remind (plan/ENGINEERING_WORKFLOW.md CP4, plan/OPERATIONS.md N2), every 10 minutes:
// - events with `remind: true`: 7 days before (d7), the day before (d1) and on the day (d0), each from 08:00 couple time
//   of that day; timed events also 1 hour before (h1, any time of day);
// - auto milestones (anniversary years, "Tròn N ngày"): the day before (d1) and on the day (d0), from 08:00.
// A reminder is only sent on its own day (d7/d1/d0) or inside its hour (h1): a server that was down catches up later
// the same day, but never sends yesterday's reminder or a reminder after the start.
// On day D of a timed event, d0 is skipped once the 1-hour window has begun (h1 is the reminder then; an 08:30 meetup
// gets h1 at 07:30 and no "Hôm nay" at 08:00).
// Guard: claimSend(`cp-event:<id>:<occurrence date>:<d7|d1|d0|h1>`) (pattern b in scheduler.service.ts). The occurrence
// date is in the key, so a yearly event is reminded again next year and a date change gives new keys. Auto milestones
// use `<coupleId>-<auto id>` as id (auto ids such as "auto-days-100" are the same for every couple), like the .ics UID.

/** Day reminders (d7, d1, d0) go out from this time, couple timezone. */
export const REMIND_FROM = '08:00';
const HOUR_MS = 3_600_000;
const COUPLES_PER_PAGE = 50;
const EVENTS_PER_RUN = 500;

export type ReminderSlot = 'd7' | 'd1' | 'd0' | 'h1';
const DAY_SLOTS: readonly (readonly [ReminderSlot, number])[] = [
  ['d7', 7],
  ['d1', 1],
  ['d0', 0],
];

export interface EventReminder {
  key: string;
  coupleId: Types.ObjectId;
  /** Both members get it. */
  memberIds: Types.ObjectId[];
  /** Stored event id, or the auto milestone id ("auto-days-100", "auto-years-2"). */
  eventId: string;
  auto: boolean;
  title: string;
  emoji: string;
  /** The occurrence reminded of ("YYYY-MM-DD", couple timezone). */
  date: string;
  time: string | null;
  slot: ReminderSlot;
}

export function reminderKey(eventKeyId: string, date: string, slot: ReminderSlot): string {
  return `cp-event:${eventKeyId}:${date}:${slot}`;
}

function occursOn(e: { date: string; repeat: EventRepeat }, day: string): boolean {
  return e.repeat === 'yearly' ? nextYearlyDate(e.date, day) === day : e.date === day;
}

/** The reminders due for one couple at `now` (no database access). */
export function dueReminders(couple: CoupleDoc, events: RemindableEvent[], now: Date, includeAuto = true): EventReminder[] {
  const tz = couple.timezone;
  const today = getLocalDate(now, tz);
  const tomorrow = addDays(today, 1);
  const t = now.getTime();
  const dayRemindersOpen = t >= zonedTimeToUtc(today, REMIND_FROM, tz).getTime();
  const base = { coupleId: couple._id, memberIds: couple.memberIds };
  const out: EventReminder[] = [];

  for (const e of events) {
    const id = e._id.toString();
    const time = e.time ?? null;
    const add = (date: string, slot: ReminderSlot) =>
      out.push({ ...base, key: reminderKey(id, date, slot), eventId: id, auto: false, title: e.title, emoji: e.emoji, date, time, slot });
    if (dayRemindersOpen) {
      for (const [slot, offset] of DAY_SLOTS) {
        const day = addDays(today, offset);
        if (!occursOn(e, day)) continue;
        if (slot === 'd0' && time && t >= zonedTimeToUtc(day, time, tz).getTime() - HOUR_MS) continue;
        add(day, slot);
      }
    }
    if (time) {
      // Today, or just after midnight tomorrow (a 00:30 start is reminded at 23:30).
      for (const day of [today, tomorrow]) {
        if (!occursOn(e, day)) continue;
        const start = zonedTimeToUtc(day, time, tz).getTime();
        if (t >= start - HOUR_MS && t < start) add(day, 'h1');
      }
    }
  }

  if (includeAuto && dayRemindersOpen) {
    for (const m of autoMilestones(couple, today)) {
      const slot: ReminderSlot | null = m.nextDate === today ? 'd0' : m.nextDate === tomorrow ? 'd1' : null;
      if (!slot) continue;
      out.push({
        ...base,
        key: reminderKey(`${couple._id.toString()}-${m.id}`, m.nextDate, slot),
        eventId: m.id,
        auto: true,
        title: m.title,
        emoji: m.emoji,
        date: m.nextDate,
        time: null,
        slot,
      });
    }
  }
  return out;
}

/** Lock-screen line of one reminder (group couple.reminders); the title is the couple's own event name. */
export function reminderBody(r: Pick<EventReminder, 'slot' | 'emoji' | 'title' | 'time'>): string {
  const what = `${r.emoji} ${r.title}`.trim();
  switch (r.slot) {
    case 'd7':
      return `Còn 7 ngày nữa: ${what}`;
    case 'd1':
      return `Ngày mai: ${what}`;
    case 'd0':
      return `Hôm nay: ${what}`;
    case 'h1':
      return r.time ? `1 giờ nữa: ${what} (${r.time})` : `1 giờ nữa: ${what}`;
  }
}

/**
 * Remind both members of one event occurrence. Called once per key. No actor (nobody did anything), so both get it;
 * TTL 4 h (timed type) and quiet hours apply in push.service.
 */
export async function deliverEventReminder(r: EventReminder): Promise<void> {
  logger.debug('Event reminder due', {
    coupleId: r.coupleId.toString(),
    eventId: r.eventId,
    slot: r.slot,
    date: r.date,
    key: r.key,
  });
  const body = reminderBody(r);
  const entityId = !r.auto && Types.ObjectId.isValid(r.eventId) ? new Types.ObjectId(r.eventId) : null;
  for (const to of r.memberIds) {
    await notificationService.emit({ space: 'couple', coupleId: r.coupleId, to, actorId: null, type: 'event_reminder', entityId,
      eventKey: r.key, target: { kind: 'event', id: r.eventId }, push: { body, url: '/events', tag: `event:${r.eventId}` } });
  }
}

// Process-local positions only; claims remain the durable duplicate guard, not delivery receipts.
let afterCouple: Types.ObjectId | null = null;
let current: { id: Types.ObjectId; afterEvent?: Types.ObjectId; autoScope?: string } | null = null;
let activeRun: Promise<number> | null = null;

async function sendDue(due: EventReminder[]): Promise<number> {
  if (!due.length) return 0;
  const done = await alreadySent(due.map(r => r.key));
  let sent = 0;
  for (const r of due) {
    if (done.has(r.key) || !(await claimSend(r.key))) continue;
    await realtimeAudience.couple(r.coupleId, ['events']);
    await deliverEventReminder(r);
    sent++;
  }
  return sent;
}

async function run(now: Date): Promise<number> {
  const utcToday = getLocalDate(now, 'UTC');
  const fromDay = addDays(utcToday, -1), toDay = addDays(utcToday, 9);
  let sent = 0, candidates = 0, couples = 0;
  while (couples < COUPLES_PER_PAGE && candidates < EVENTS_PER_RUN) {
    let couple: CoupleDoc | null;
    if (current) couple = await coupleRepository.findActiveById(current.id);
    else {
      const page = await coupleRepository.listActivePage(afterCouple, 1);
      if (!page.length) { afterCouple = null; break; }
      couple = page[0];
      current = { id: couple._id };
    }
    couples++;
    if (!couple) { afterCouple = current!.id; current = null; continue; }
    const localDay = getLocalDate(now, couple.timezone);
    // A long traversal may cross 08:00, midnight or a timezone edit. Do not
    // remember a pre-window empty result as completed for the next window.
    const autoScope = `${couple.timezone}:${localDay}`;
    if (now.getTime() >= zonedTimeToUtc(localDay, REMIND_FROM, couple.timezone).getTime()
      && current!.autoScope !== autoScope) {
      sent += await sendDue(dueReminders(couple, [], now));
      current!.autoScope = autoScope;
    }
    const remaining = EVENTS_PER_RUN - candidates;
    const rows = await eventRepository.listRemindablePage(couple._id, fromDay, toDay, remaining, current!.afterEvent);
    for (const event of rows.slice(0, remaining)) {
      sent += await sendDue(dueReminders(couple, [event], now, false));
      current!.afterEvent = event._id;
      candidates++;
    }
    if (rows.length > remaining) break;
    afterCouple = couple._id;
    current = null;
  }
  return sent;
}

export const coupleEventsRemindJob: SchedulerJob = {
  name: 'couple-events.remind',
  everyMin: 10,
  run(now) {
    if (activeRun) return activeRun;
    const promise = run(now).finally(() => { if (activeRun === promise) activeRun = null; });
    activeRun = promise;
    return promise;
  },
};
