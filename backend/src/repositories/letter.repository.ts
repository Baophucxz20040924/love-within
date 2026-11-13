import type { Types } from 'mongoose';
import { CoupleLetter, type CoupleLetterDoc, type LetterPhoto } from '../models/CoupleLetter.js';

export interface LetterContent {
  title: string;
  body: string;
  photos: LetterPhoto[];
  openOn: string;
  openAt: Date;
}

const alive = { deletedAt: null };

/** Safety bound per list: a couple writes a few letters a month; this only stops a runaway list from growing a response. */
const MAX_LIST = 200;
/** The Home card only needs "how many" for small numbers. */
const MAX_OPENABLE = 100;

/**
 * Every query is scoped by coupleId (Requirement 3.4). Edits and deletes also require authorId and an unopened letter;
 * opening requires recipientId and openAt ≤ now, so the conditions are checked atomically by MongoDB.
 */
export const letterRepository = {
  create(input: LetterContent & { coupleId: Types.ObjectId; authorId: Types.ObjectId; recipientId: Types.ObjectId }): Promise<CoupleLetterDoc> {
    return CoupleLetter.create(input);
  },

  findById(coupleId: Types.ObjectId, id: string): Promise<CoupleLetterDoc | null> {
    return CoupleLetter.findOne({ _id: id, coupleId, ...alive }).exec();
  },

  /** Letters to me, soonest open time first (the service orders them for display). */
  listInbox(coupleId: Types.ObjectId, recipientId: Types.ObjectId): Promise<CoupleLetterDoc[]> {
    return CoupleLetter.find({ coupleId, recipientId, ...alive }).sort({ openAt: 1, _id: 1 }).limit(MAX_LIST).exec();
  },

  /** Letters I wrote, newest first. */
  listSent(coupleId: Types.ObjectId, authorId: Types.ObjectId): Promise<CoupleLetterDoc[]> {
    return CoupleLetter.find({ coupleId, authorId, ...alive }).sort({ createdAt: -1, _id: -1 }).limit(MAX_LIST).exec();
  },

  /** Author only, and only while unopened. A new open date clears readyNotifiedAt so the job announces the new date. */
  updateContent(
    coupleId: Types.ObjectId,
    id: Types.ObjectId,
    authorId: Types.ObjectId,
    content: LetterContent,
    openDateChanged: boolean,
  ): Promise<CoupleLetterDoc | null> {
    const set: Record<string, unknown> = { ...content, editedAt: new Date() };
    if (openDateChanged) set.readyNotifiedAt = null;
    return CoupleLetter.findOneAndUpdate({ _id: id, coupleId, authorId, ...alive, openedAt: null }, { $set: set }, { new: true }).exec();
  },

  /** Author only, and only while unopened. Photos stay in storage (an admin can restore the letter). */
  softDelete(coupleId: Types.ObjectId, id: Types.ObjectId, authorId: Types.ObjectId): Promise<CoupleLetterDoc | null> {
    return CoupleLetter.findOneAndUpdate(
      { _id: id, coupleId, authorId, ...alive, openedAt: null },
      { $set: { deletedAt: new Date() } },
      { new: true },
    ).exec();
  },

  /** First open: only the recipient, only once the time has come, and only once (openedAt is written a single time). */
  markOpened(coupleId: Types.ObjectId, id: Types.ObjectId, recipientId: Types.ObjectId, now: Date): Promise<CoupleLetterDoc | null> {
    return CoupleLetter.findOneAndUpdate(
      { _id: id, coupleId, recipientId, ...alive, openAt: { $lte: now }, openedAt: null },
      { $set: { openedAt: now } },
      { new: true },
    ).exec();
  },

  /** Unopened letters to me whose time has come, oldest open time first (ids only). */
  async openableIds(coupleId: Types.ObjectId, recipientId: Types.ObjectId, now: Date): Promise<Types.ObjectId[]> {
    const docs = await CoupleLetter.find({ coupleId, recipientId, ...alive, openedAt: null, openAt: { $lte: now } })
      .sort({ openAt: 1, _id: 1 })
      .select('_id')
      .limit(MAX_OPENABLE)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return docs.map((d) => d._id);
  },

  /** The next sealed letter to me (open date only). */
  async nextSealedOpenOn(coupleId: Types.ObjectId, recipientId: Types.ObjectId, now: Date): Promise<string | null> {
    const doc = await CoupleLetter.findOne({ coupleId, recipientId, ...alive, openAt: { $gt: now } })
      .sort({ openAt: 1 })
      .select('openOn')
      .lean<{ openOn: string }>()
      .exec();
    return doc?.openOn ?? null;
  },

  // ── Job letters.ready (N2). Scans across couples by design; nothing here is returned to a client. ──

  /** Letters whose time has come and that were not announced, opened or deleted; oldest open time first (ids only). */
  async listReadyToAnnounce(now: Date, limit: number): Promise<Types.ObjectId[]> {
    const docs = await CoupleLetter.find({ ...readyToAnnounce(now) })
      .sort({ openAt: 1 })
      .select('_id')
      .limit(limit)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return docs.map((d) => d._id);
  },

  /**
   * The atomic flag of letters.ready: sets readyNotifiedAt only while the letter is still due (not announced, not opened,
   * not deleted, open time not moved). Exactly one caller gets the document back and announces the letter.
   */
  markReadyNotified(id: Types.ObjectId, now: Date): Promise<CoupleLetterDoc | null> {
    return CoupleLetter.findOneAndUpdate({ _id: id, ...readyToAnnounce(now) }, { $set: { readyNotifiedAt: now } }, { new: true }).exec();
  },
};

/** letters.ready picks these (index { readyNotifiedAt, openAt }). */
function readyToAnnounce(now: Date) {
  return { readyNotifiedAt: null, openAt: { $lte: now }, openedAt: null, ...alive };
}
