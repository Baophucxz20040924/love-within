import { Types } from 'mongoose';
import { CoupleEvent, type CoupleEventDoc, type EventKind, type EventRepeat } from '../models/CoupleEvent.js';

export interface EventContent {
  title: string;
  emoji: string;
  kind: EventKind;
  personId: Types.ObjectId | null;
  date: string;
  time: string | null;
  repeat: EventRepeat;
  note: string;
  remind: boolean;
}

/** What the reminder job reads of an event (no note). */
export type RemindableEvent = Pick<CoupleEventDoc, '_id' | 'coupleId' | 'title' | 'emoji' | 'date' | 'time' | 'repeat'>;

const alive = { deletedAt: null };

/** Safety bounds: a couple has a few dozen events; these only stop a runaway list from growing a response. */
const MAX_UPCOMING = 300;
const MAX_PAST = 100;

/** Every query is scoped by coupleId (Requirement 3.4). Both members may edit or delete any event of their couple. */
export const eventRepository = {
  create(input: EventContent & { coupleId: Types.ObjectId; createdBy: Types.ObjectId }): Promise<CoupleEventDoc> {
    return CoupleEvent.create({ ...input, updatedBy: input.createdBy });
  },

  findById(coupleId: Types.ObjectId, id: string): Promise<CoupleEventDoc | null> {
    return CoupleEvent.findOne({ _id: id, coupleId, ...alive }).exec();
  },

  /** Yearly events (always have a next date) and one-off events on or after `today`. */
  listUpcoming(coupleId: Types.ObjectId, today: string): Promise<CoupleEventDoc[]> {
    return CoupleEvent.find({ coupleId, ...alive, $or: [{ repeat: 'yearly' }, { date: { $gte: today } }] })
      .limit(MAX_UPCOMING)
      .exec();
  },

  /** One-off events before `today`, most recent first ("Đã qua"). */
  listPast(coupleId: Types.ObjectId, today: string): Promise<CoupleEventDoc[]> {
    return CoupleEvent.find({ coupleId, ...alive, repeat: 'none', date: { $lt: today } })
      .sort({ date: -1, time: -1, _id: -1 })
      .limit(MAX_PAST)
      .exec();
  },

  update(coupleId: Types.ObjectId, id: Types.ObjectId, content: EventContent, updatedBy: Types.ObjectId): Promise<CoupleEventDoc | null> {
    return CoupleEvent.findOneAndUpdate({ _id: id, coupleId, ...alive }, { $set: { ...content, updatedBy } }, { new: true }).exec();
  },

  softDelete(coupleId: Types.ObjectId, id: string, deletedBy: Types.ObjectId): Promise<CoupleEventDoc | null> {
    return CoupleEvent.findOneAndUpdate(
      { _id: id, coupleId, ...alive },
      { $set: { deletedAt: new Date(), updatedBy: deletedBy } },
      { new: true },
    ).exec();
  },

  /**
   * Job couple-events.remind (N2): the reminder-on events of a page of couples that can occur between `fromDay` and
   * `toDay` (yearly events always can). Uses the { coupleId, deletedAt } index; capped by `limit`.
   */
  listRemindablePage(coupleId: Types.ObjectId, fromDay: string, toDay: string, limit: number, after?: Types.ObjectId): Promise<RemindableEvent[]> {
    return CoupleEvent.find({ coupleId, ...alive, remind: true, ...(after ? { _id: { $gt: after } } : {}),
      $or: [{ repeat: 'yearly' }, { date: { $gte: fromDay, $lte: toDay } }],
    }).sort({ _id: 1 }).select('coupleId title emoji date time repeat').limit(limit + 1).lean<RemindableEvent[]>().exec();
  },

  listRemindable(coupleIds: Types.ObjectId[], fromDay: string, toDay: string, limit: number): Promise<RemindableEvent[]> {
    return CoupleEvent.find({
      coupleId: { $in: coupleIds },
      ...alive,
      remind: true,
      $or: [{ repeat: 'yearly' }, { date: { $gte: fromDay, $lte: toDay } }],
    })
      .select('coupleId title emoji date time repeat')
      .limit(limit)
      .lean<RemindableEvent[]>()
      .exec();
  },
};
