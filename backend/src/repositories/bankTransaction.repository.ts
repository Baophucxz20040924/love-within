import { Types } from 'mongoose';
import { BankTransaction, type BankTransactionDoc, type TxnDirection } from '../models/BankTransaction.js';

export interface TxnRow {
  providerTxnId: string;
  direction: TxnDirection;
  amount: number;
  occurredAt: Date;
  localDate: string;
}

export interface TxnListFilter {
  month?: string; // YYYY-MM
  direction?: TxnDirection;
  cursor?: string; // _id of the last item of the previous page
  limit: number;
}

export interface TxnSummary {
  totalIn: number;
  totalOut: number;
  count: number;
}

/** Minimal row for AI context: no ids, no provider reference. */
export interface TxnRangeRow {
  direction: TxnDirection;
  amount: number;
  occurredAt: Date;
  localDate: string;
  note: string;
  noteUpdatedAt: Date | null;
}

function monthRange(month: string): { $gte: string; $lte: string } {
  return { $gte: `${month}-01`, $lte: `${month}-31` };
}

/** Every query is scoped by userId (the owner). Note edits also require it, so a partner can never match. */
export const bankTransactionRepository = {
  /**
   * Insert transactions we have not seen yet. `$setOnInsert` only: re-polling never touches
   * existing rows, so the owner's note is never overwritten. Returns the number of new rows.
   */
  async upsertMany(userId: Types.ObjectId, connectionId: Types.ObjectId, rows: TxnRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await BankTransaction.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: { userId, providerTxnId: r.providerTxnId },
          update: {
            $setOnInsert: {
              userId,
              connectionId,
              providerTxnId: r.providerTxnId,
              direction: r.direction,
              amount: r.amount,
              occurredAt: r.occurredAt,
              localDate: r.localDate,
              note: '',
              noteUpdatedAt: null,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return res.upsertedCount;
  },

  /** Newest first. Fetches limit + 1 so the caller knows whether another page exists. */
  async list(userId: Types.ObjectId, f: TxnListFilter): Promise<BankTransactionDoc[]> {
    const filter: Record<string, unknown> = { userId };
    if (f.month) filter.localDate = monthRange(f.month);
    if (f.direction) filter.direction = f.direction;
    if (f.cursor) {
      const last = await BankTransaction.findOne({ _id: f.cursor, userId }).select('occurredAt').lean().exec();
      if (!last) return [];
      filter.$or = [
        { occurredAt: { $lt: last.occurredAt } },
        { occurredAt: last.occurredAt, _id: { $lt: new Types.ObjectId(f.cursor) } },
      ];
    }
    return BankTransaction.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(f.limit + 1).exec();
  },

  async summary(userId: Types.ObjectId, month: string): Promise<TxnSummary> {
    const rows = await BankTransaction.aggregate<{ _id: TxnDirection; total: number; count: number }>([
      { $match: { userId, localDate: monthRange(month) } },
      { $group: { _id: '$direction', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]).exec();
    const by = new Map(rows.map((r) => [r._id, r]));
    return {
      totalIn: by.get('in')?.total ?? 0,
      totalOut: by.get('out')?.total ?? 0,
      count: (by.get('in')?.count ?? 0) + (by.get('out')?.count ?? 0),
    };
  },

  /** All transactions with localDate in [from, to] (inclusive), newest first, capped at `limit`. */
  listRange(userId: Types.ObjectId, from: string, to: string, limit: number): Promise<TxnRangeRow[]> {
    return BankTransaction.find({ userId, localDate: { $gte: from, $lte: to } })
      .select('-_id direction amount occurredAt localDate note noteUpdatedAt')
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean<TxnRangeRow[]>()
      .exec();
  },

  /** Owner only: the userId filter means a partner's request never matches (→ 404). */
  updateNote(userId: Types.ObjectId, id: string, note: string): Promise<BankTransactionDoc | null> {
    return BankTransaction.findOneAndUpdate(
      { _id: id, userId },
      { $set: { note, noteUpdatedAt: new Date() } },
      { new: true, runValidators: true },
    ).exec();
  },

  async deleteAllForUser(userId: Types.ObjectId): Promise<number> {
    const res = await BankTransaction.deleteMany({ userId }).exec();
    return res.deletedCount;
  },
};
