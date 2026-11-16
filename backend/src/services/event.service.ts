import { realtimeAudience } from './realtimeAudience.service.js';
import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import { DEFAULT_EVENT_EMOJI, defaultRepeatFor, type CoupleEventDoc, type EventKind, type EventRepeat } from '../models/CoupleEvent.js';
import { eventRepository, type EventContent } from '../repositories/event.repository.js';
import { MILESTONES } from './couple.service.js';
import { notificationService } from './notification.service.js';
import { addDays, daysUntil, formatDayVi, getLocalDate, nextYearlyDate, yearlyDateIn, zonedTimeToUtc } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// "Đếm ngược sự kiện" (plan/ENGINEERING_WORKFLOW.md, CP4). Owner decision 10/11/2026: either member creates, edits or deletes
// an event without the partner's approval (the anniversary date itself still goes through a proposal).
// Titles and notes are never logged.

/** Home card "Sắp tới": only events in the next 30 days (COUPLE_V2_PLAN §0). */
const HOME_HORIZON_DAYS = 30;
/** Day milestones listed ahead on /events: every one in the next year, and always at least the next one. */
const AUTO_DAYS_HORIZON = 365;
const AUTO_DAYS_PREFIX = 'auto-days-';
const AUTO_YEARS_PREFIX = 'auto-years-';

const numberVi = new Intl.NumberFormat('vi-VN');

export interface EventView {
  /** ObjectId of a stored event, or "auto-days-100" / "auto-years-2" for a milestone derived from the anniversary date. */
  id: string;
  /** Derived from the anniversary date: not stored, not editable. */
  auto: boolean;
  title: string;
  emoji: string;
  kind: EventKind;
  /** Whose birthday (member id); null for other kinds. */
  personId: string | null;
  /** The stored day (for a yearly event: the first/original day, e.g. the birth date). */
  date: string;
  time: string | null;
  repeat: EventRepeat;
  note: string;
  remind: boolean;
  /** Next occurrence in the couple timezone (= `date` for one-off events, including past ones). */
  nextDate: string;
  /** Days from today (couple timezone) to `nextDate`: 0 = today, negative = past. */
  daysLeft: number;
  /** UTC instant of `nextDate` + `time` in the couple timezone (live countdown); null when all day. */
  startsAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EventList {
  /** Next occurrence first; includes yearly events and the auto milestones. */
  upcoming: EventView[];
  /** One-off events whose day has passed, most recent first. */
  past: EventView[];
}

/** GET /api/couple/pulse → nextEvent: the nearest event in the next 30 days, for the Home card. */
export interface PulseNextEvent {
  id: string;
  auto: boolean;
  title: string;
  emoji: string;
  kind: EventKind;
  /** Next occurrence ("YYYY-MM-DD", couple timezone). */
  date: string;
  time: string | null;
  startsAt: string | null;
  daysLeft: number;
  /** Other events in the next 30 days ("và N sự kiện khác"). */
  others: number;
}

/** Fields as the API receives them (create: all required ones present; edit: any subset). */
export interface EventInput {
  title?: string;
  emoji?: string;
  kind?: EventKind;
  personId?: string | null;
  date?: string;
  time?: string | null;
  repeat?: EventRepeat;
  note?: string;
  remind?: boolean;
}

type EventFields = Required<Pick<EventInput, 'title' | 'kind' | 'date'>> & EventInput;

const notFound = () => Errors.notFound('Sự kiện không tồn tại');

function todayOf(couple: CoupleDoc): string {
  return getLocalDate(new Date(), couple.timezone);
}

/**
 * Validate the cross-field rules zod cannot see: a birthday needs a person, and any person must be one of the two members.
 * Applies the defaults (emoji and repeat by kind).
 */
function normalize(couple: CoupleDoc, input: EventFields): EventContent {
  let personId: Types.ObjectId | null = null;
  if (input.personId) {
    const wanted = input.personId.toLowerCase();
    const member = couple.memberIds.find((m) => m.toString() === wanted);
    if (!member) throw Errors.badRequest('Người này không ở trong cặp đôi của bạn');
    if (input.kind === 'birthday') personId = member;
  }
  if (input.kind === 'birthday' && !personId) throw Errors.badRequest('Hãy chọn đây là sinh nhật của ai');
  return {
    title: input.title.trim(),
    emoji: input.emoji?.trim() || DEFAULT_EVENT_EMOJI[input.kind],
    kind: input.kind,
    personId,
    date: input.date,
    time: input.time ?? null,
    repeat: input.repeat ?? defaultRepeatFor(input.kind),
    note: (input.note ?? '').trim(),
    remind: input.remind ?? true,
  };
}

function startsAtOf(couple: CoupleDoc, day: string, time: string | null): string | null {
  return time ? zonedTimeToUtc(day, time, couple.timezone).toISOString() : null;
}

function viewOf(couple: CoupleDoc, e: CoupleEventDoc, today: string): EventView {
  const nextDate = e.repeat === 'yearly' ? nextYearlyDate(e.date, today) : e.date;
  return {
    id: e._id.toString(),
    auto: false,
    title: e.title,
    emoji: e.emoji,
    kind: e.kind,
    personId: e.personId ? e.personId.toString() : null,
    date: e.date,
    time: e.time ?? null,
    repeat: e.repeat,
    note: e.note ?? '',
    remind: e.remind,
    nextDate,
    daysLeft: daysUntil(today, nextDate),
    startsAt: startsAtOf(couple, nextDate, e.time ?? null),
    createdBy: e.createdBy.toString(),
    updatedBy: e.updatedBy.toString(),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function autoView(today: string, a: { id: string; title: string; emoji: string; date: string; repeat: EventRepeat; nextDate: string }): EventView {
  return {
    ...a,
    auto: true,
    kind: 'anniversary',
    personId: null,
    time: null,
    note: '',
    remind: true,
    daysLeft: daysUntil(today, a.nextDate),
    startsAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Milestones derived from the anniversary date (not stored): the next yearly anniversary, plus the day milestones of
 * MILESTONES (the Hero's list) in the next year, at least the next one. Day N falls on start + N days, the same count as
 * the Hero's "ngày bên nhau" (couple.service.ts), so "Hôm nay tròn 100 ngày" and this list always agree.
 * A day milestone on the same date as the yearly anniversary (365 days without a 29/02 in between) is shown once, as the anniversary.
 */
export function autoMilestones(couple: CoupleDoc, today: string): EventView[] {
  if (!couple.anniversaryDate) return [];
  const start = getLocalDate(couple.anniversaryDate, couple.timezone);
  const startYear = Number(start.slice(0, 4));
  let year = Math.max(startYear + 1, Number(today.slice(0, 4)));
  let yearly = yearlyDateIn(start, year);
  if (yearly < today) yearly = yearlyDateIn(start, ++year);
  const years = year - startYear;

  const items: EventView[] = [
    autoView(today, {
      id: `${AUTO_YEARS_PREFIX}${years}`,
      title: `Kỷ niệm ${years} năm yêu nhau`,
      emoji: '🥂',
      date: start,
      repeat: 'yearly',
      nextDate: yearly,
    }),
  ];
  let listed = 0;
  for (const days of MILESTONES) {
    const date = addDays(start, days);
    if (date < today) continue;
    if (listed > 0 && daysUntil(today, date) > AUTO_DAYS_HORIZON) break;
    listed++;
    if (date === yearly) continue;
    items.push(
      autoView(today, {
        id: `${AUTO_DAYS_PREFIX}${days}`,
        title: `Tròn ${numberVi.format(days)} ngày yêu nhau`,
        emoji: '💞',
        date,
        repeat: 'none',
        nextDate: date,
      }),
    );
  }
  return items;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Soonest first; on the same day all-day events first, then by time; stored events before auto milestones. */
function byNext(a: EventView, b: EventView): number {
  return (
    cmp(a.nextDate, b.nextDate) ||
    cmp(a.time ?? '', b.time ?? '') ||
    Number(a.auto) - Number(b.auto) ||
    cmp(a.createdAt ?? '', b.createdAt ?? '') ||
    cmp(a.id, b.id)
  );
}

async function upcomingOf(couple: CoupleDoc, today: string): Promise<EventView[]> {
  const docs = await eventRepository.listUpcoming(couple._id, today);
  return [...docs.map((e) => viewOf(couple, e, today)), ...autoMilestones(couple, today)].sort(byNext);
}

export const eventService = {
  async list(couple: CoupleDoc): Promise<EventList> {
    const today = todayOf(couple);
    const [upcoming, pastDocs] = await Promise.all([upcomingOf(couple, today), eventRepository.listPast(couple._id, today)]);
    return { upcoming, past: pastDocs.map((e) => viewOf(couple, e, today)) };
  },

  async create(couple: CoupleDoc, userId: string, input: EventFields): Promise<EventView> {
    const uid = new Types.ObjectId(userId);
    const doc = await eventRepository.create({ ...normalize(couple, input), coupleId: couple._id, createdBy: uid });
    await realtimeAudience.couple(couple._id, ['events']);
    logger.info('Couple event created', {
      coupleId: couple._id.toString(),
      userId,
      eventId: doc._id.toString(),
      kind: doc.kind,
      repeat: doc.repeat,
    });
    const view = viewOf(couple, doc, todayOf(couple));
    // Owner decision (10/11/2026): no dual approval, the partner is told. Date = the next occurrence.
    await notificationService.toPartner(couple, uid, {
      type: 'event_created',
      entityId: doc._id, eventKey: String(doc._id),
      target: { kind: 'event', id: String(doc._id) },
      push: {
        body: (name) => `${name} đã thêm sự kiện “${doc.title}” (${formatDayVi(view.nextDate)})`,
        url: '/events',
        tag: `event:${doc._id.toString()}`,
      },
    });
    return view;
  },

  /** Either member edits any field; the merged event is validated again (e.g. switching to "birthday" needs a person). */
  async update(couple: CoupleDoc, userId: string, id: string, patch: EventInput): Promise<EventView> {
    const existing = await eventRepository.findById(couple._id, id);
    if (!existing) throw notFound();
    const merged: EventFields = {
      title: existing.title,
      emoji: existing.emoji,
      kind: existing.kind,
      personId: existing.personId ? existing.personId.toString() : null,
      date: existing.date,
      time: existing.time ?? null,
      repeat: existing.repeat,
      note: existing.note ?? '',
      remind: existing.remind,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    const doc = await eventRepository.update(couple._id, existing._id, normalize(couple, merged), new Types.ObjectId(userId));
    if (!doc) throw notFound(); // deleted by the partner a moment ago
    await realtimeAudience.couple(couple._id, ['events']);
    logger.info('Couple event updated', { coupleId: couple._id.toString(), userId, eventId: id, kind: doc.kind, repeat: doc.repeat });
    return viewOf(couple, doc, todayOf(couple));
  },

  /** Soft delete; either member. */
  async remove(couple: CoupleDoc, userId: string, id: string): Promise<void> {
    const doc = await eventRepository.softDelete(couple._id, id, new Types.ObjectId(userId));
    if (!doc) throw notFound();
    await realtimeAudience.couple(couple._id, ['events']);
    logger.info('Couple event deleted', { coupleId: couple._id.toString(), userId, eventId: id });
  },

  /**
   * Home card: the nearest event in the next 30 days. Day milestones are left out because the Hero already counts down
   * to the next one ("Còn 12 ngày tới mốc 200 ngày"); the yearly anniversary is included.
   */
  async pulse(couple: CoupleDoc): Promise<PulseNextEvent | null> {
    const today = todayOf(couple);
    const soon = (await upcomingOf(couple, today)).filter(
      (e) => e.daysLeft <= HOME_HORIZON_DAYS && !e.id.startsWith(AUTO_DAYS_PREFIX),
    );
    const first = soon[0];
    if (!first) return null;
    return {
      id: first.id,
      auto: first.auto,
      title: first.title,
      emoji: first.emoji,
      kind: first.kind,
      date: first.nextDate,
      time: first.time,
      startsAt: first.startsAt,
      daysLeft: first.daysLeft,
      others: soon.length - 1,
    };
  },
};
