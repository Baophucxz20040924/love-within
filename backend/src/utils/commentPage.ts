import { Types } from 'mongoose';
import { encodeHistoryCursor, type HistoryPosition } from './historyCursor.js';

/** Keep report visibility and the seek in separate $and clauses (both contain $or). */
export function commentPageFilter(viewerId: Types.ObjectId, blocked: Types.ObjectId[], before?: HistoryPosition, inclusive = false) {
  return { deletedAt: null, ...(blocked.length ? { authorId: { $nin: blocked } } : {}), $and: [
    { $or: [{ hiddenByReportsAt: null }, { authorId: viewerId }] },
    ...(before ? [{ $or: [
      { createdAt: { $lt: before.createdAt } },
      { createdAt: before.createdAt, _id: { [inclusive ? '$lte' : '$lt']: new Types.ObjectId(before.id) } },
    ] }] : []),
  ] };
}

export function commentPage<T extends { _id: Types.ObjectId; createdAt: Date }>(rows: T[], limit: number, scope: string) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last
    ? encodeHistoryCursor(scope, { createdAt: last.createdAt, id: last._id.toString() }) : null };
}
