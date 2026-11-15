import { Types } from 'mongoose';
import { BucketItem, BucketRewardDay, type BucketCategory, type BucketItemDoc, type BucketStatus } from '../models/BucketItem.js';

export interface BucketContent {
  title: string;
  emoji: string;
  category: BucketCategory;
  note: string;
  dueOn: string | null;
  pinned: boolean;
}

const alive = { deletedAt: null };

/** Safety bound per list: a couple has a few dozen items; this only stops a runaway list from growing a response. */
const MAX_LIST = 500;

/** Mongo duplicate-key error (a unique index refused an insert). */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Every query is scoped by coupleId (Requirement 3.4). Both members may edit, delete or complete any item of their couple. */
export const bucketRepository = {
  create(input: BucketContent & { coupleId: Types.ObjectId; createdBy: Types.ObjectId; ideaId: string | null }): Promise<BucketItemDoc> {
    return BucketItem.create({ ...input, updatedBy: input.createdBy });
  },

  findById(coupleId: Types.ObjectId, id: string | Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOne({ _id: id, coupleId, ...alive }).exec();
  },

  /** Including deleted items (to tell "deleted a moment ago" from "never existed"). */
  findAnyById(coupleId: Types.ObjectId, id: string | Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOne({ _id: id, coupleId }).exec();
  },

  /**
   * "Chưa làm": pinned first, then the nearest due date (items without one after), then the newest.
   * "Đã làm": the most recently done first.
   */
  async list(coupleId: Types.ObjectId, status: BucketStatus): Promise<BucketItemDoc[]> {
    if (status === 'done') {
      return BucketItem.find({ coupleId, ...alive, status }).sort({ doneOn: -1, doneAt: -1, _id: -1 }).limit(MAX_LIST).exec();
    }
    const docs = await BucketItem.find({ coupleId, ...alive, status }).limit(MAX_LIST).exec();
    return docs.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.dueOn ?? '9999-99-99').localeCompare(b.dueOn ?? '9999-99-99') ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b._id.toString().localeCompare(a._id.toString()),
    );
  },

  async counts(coupleId: Types.ObjectId): Promise<{ todo: number; done: number }> {
    const [todo, done] = await Promise.all([
      BucketItem.countDocuments({ coupleId, ...alive, status: 'todo' }).exec(),
      BucketItem.countDocuments({ coupleId, ...alive, status: 'done' }).exec(),
    ]);
    return { todo, done };
  },

  /** Idea ids already on the list (not deleted), for "Đã thêm" in the picker. */
  async addedIdeaIds(coupleId: Types.ObjectId): Promise<Set<string>> {
    const ids = await BucketItem.distinct('ideaId', { coupleId, ...alive, ideaId: { $ne: null } }).exec();
    return new Set(ids.filter((v): v is string => typeof v === 'string'));
  },

  update(coupleId: Types.ObjectId, id: Types.ObjectId, content: BucketContent, updatedBy: Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOneAndUpdate({ _id: id, coupleId, ...alive }, { $set: { ...content, updatedBy } }, { new: true }).exec();
  },

  softDelete(coupleId: Types.ObjectId, id: string, deletedBy: Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOneAndUpdate(
      { _id: id, coupleId, ...alive },
      { $set: { deletedAt: new Date(), updatedBy: deletedBy } },
      { new: true },
    ).exec();
  },

  restore(coupleId: Types.ObjectId, id: string, restoredBy: Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOneAndUpdate(
      { _id: id, coupleId, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: restoredBy } },
      { new: true },
    ).exec();
  },

  /** todo → done; only one of two requests at the same moment matches. */
  markDone(
    coupleId: Types.ObjectId,
    id: Types.ObjectId,
    done: { doneOn: string; doneBy: Types.ObjectId; doneAt: Date; doneNote: string; completion: import('../models/BucketItem.js').BucketCompletion },
    rewardIntent: import('../models/WalletOperation.js').RewardIntent | null,
  ): Promise<BucketItemDoc | null> {
    return BucketItem.findOneAndUpdate(
      { _id: id, coupleId, ...alive, status: 'todo',
        // A completion paused before a complete→reopen cycle must never replace the first immutable reward claim.
        ...(rewardIntent ? { rewardIntent: null, rewardedAt: null, rewardDenied: { $ne: true } } : {}) },
      { $set: { ...done, status: 'done', storyId: null, updatedBy: done.doneBy,
        ...(rewardIntent ? { rewardIntent, rewardedAt: done.doneAt } : {}) } },
      { new: true },
    ).exec();
  },

  /** done → todo within the window (doneAt ≥ since). rewardedAt stays, so the reward is never paid again. */
  reopen(coupleId: Types.ObjectId, id: Types.ObjectId, since: Date, by: Types.ObjectId): Promise<BucketItemDoc | null> {
    return BucketItem.findOneAndUpdate(
      { _id: id, coupleId, ...alive, status: 'done', doneAt: { $gte: since }, 'completion.ready': { $ne: false } },
      { $set: { status: 'todo', doneOn: null, doneBy: null, doneAt: null, doneNote: '', storyId: null, updatedBy: by } },
      { new: true },
    ).exec();
  },

};

export const bucketRewardDayRepository = {
  /**
   * Take one of the `max` reward slots of the day; false when they are all taken. The first slot of a day creates the
   * counter; when two requests create it at the same moment, the unique index refuses one and it retries as an update.
   */
  async take(coupleId: Types.ObjectId, localDate: string, max: number, operationId: string): Promise<boolean> {
    const existing = await BucketRewardDay.findOne({ coupleId, localDate }).exec();
    if (existing?.operationIds?.includes(operationId)) return true;
    const filter = { coupleId, localDate, count: { $lt: max }, operationIds: { $ne: operationId } };
    const update = { $inc: { count: 1 }, $addToSet: { operationIds: operationId } };
    try {
      const doc = await BucketRewardDay.findOneAndUpdate(filter, update, { upsert: true, new: true }).exec();
      if (doc) return true;
    } catch (err) { if (!isDuplicateKey(err)) throw err; }
    const doc = await BucketRewardDay.findOneAndUpdate(filter, update, { new: true }).exec();
    if (doc) return true;
    const winner = await BucketRewardDay.findOne({ coupleId, localDate }).exec();
    return winner?.operationIds?.includes(operationId) ?? false;
  },
};
