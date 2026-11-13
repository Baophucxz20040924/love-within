import { Types } from 'mongoose';
import { SavingsGoal } from '../models/SavingsGoal.js';
import { SavingsEntry } from '../models/SavingsEntry.js';
import type { SavingsListInput } from '../services/savings.validation.js';
import type { SavingsGoalDoc } from '../models/SavingsGoal.js';

export type SelectedSavingsGoal = SavingsGoalDoc & { selectedTotals?: SavingsTotals };

export interface SavingsTotals { totalVnd: number; recentVnd: number; contributions: { userId: string; amountVnd: number }[] }
export const savingsRepository = {
  goal(coupleId: Types.ObjectId, id: string | Types.ObjectId) {
    return SavingsGoal.findOne({ _id: id, coupleId }).exec();
  },
  list(coupleId: Types.ObjectId, input: SavingsListInput, period?: { from: string; today: string }): Promise<SelectedSavingsGoal[]> {
    const filter: Record<string, unknown> = { coupleId };
    if (input.status === 'open' || input.status === 'active' || input.status === 'reached') filter.status = { $in: ['active', 'reached'] };
    else if (input.status !== 'all') filter.status = input.status;
    if (input.q) filter.title = { $regex: input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (input.cursor) {
      const [date, id] = input.cursor.split('_');
      filter.$or = [{ createdAt: { $lt: new Date(date) } }, { createdAt: new Date(date), _id: { $lt: new Types.ObjectId(id) } }];
    }
    if (input.status === 'active' || input.status === 'reached') {
      if (!period) throw new Error('Exact savings status requires a totals period');
      // Exact status can require examining every matching goal and its entries before
      // filling a page. Do not truncate: the 3s aggregate timeout bounds query time.
      return SavingsGoal.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1, _id: -1 } },
        { $lookup: {
          from: SavingsEntry.collection.name,
          let: { goalId: '$_id' },
          pipeline: [
            { $match: { coupleId, deletedAt: null, $expr: { $eq: ['$goalId', '$$goalId'] } } },
            { $group: { _id: '$userId', total: { $sum: '$amountVnd' },
              recent: { $sum: { $cond: [{ $and: [{ $gte: ['$occurredOn', period.from] }, { $lte: ['$occurredOn', period.today] }] }, '$amountVnd', 0] } } } },
            { $group: { _id: null, totalVnd: { $sum: '$total' }, recentVnd: { $sum: '$recent' },
              contributions: { $push: { userId: { $toString: '$_id' }, amountVnd: '$total' } } } },
          ],
          as: '_entryTotals',
        } },
        { $match: { $expr: { [input.status === 'reached' ? '$gte' : '$lt']: [
          { $ifNull: [{ $arrayElemAt: ['$_entryTotals.totalVnd', 0] }, 0] }, '$targetVnd',
        ] } } },
        { $limit: input.limit + 1 },
        { $project: { appliedProposalIds: 0 } },
      ]).option({ maxTimeMS: 3000, allowDiskUse: false }).exec().then((rows) =>
        rows.map(({ _entryTotals, ...row }) => {
          const goal: SelectedSavingsGoal = SavingsGoal.hydrate(row, { appliedProposalIds: 0 });
          goal.selectedTotals = _entryTotals[0] ?? { totalVnd: 0, recentVnd: 0, contributions: [] };
          return goal;
        }));
    }
    return SavingsGoal.find(filter).select('-appliedProposalIds').sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1).maxTimeMS(3000).exec();
  },
  async balance(coupleId: Types.ObjectId, goalId: Types.ObjectId): Promise<number> {
    // Pulse needs only the full balance, not member/recent-period grouping.
    const rows = await SavingsEntry.aggregate<{ totalVnd: number }>([
      { $match: { coupleId, goalId, deletedAt: null } },
      { $group: { _id: null, totalVnd: { $sum: '$amountVnd' } } },
    ]).exec();
    return rows[0]?.totalVnd ?? 0;
  },
  async totals(coupleId: Types.ObjectId, goalIds: Types.ObjectId[], from: string, today: string): Promise<Map<string, SavingsTotals>> {
    if (goalIds.length === 0) return new Map();
    const rows = await SavingsEntry.aggregate<{ _id: { goalId: Types.ObjectId; userId: Types.ObjectId }; total: number; recent: number }>([
      { $match: { coupleId, goalId: { $in: goalIds }, deletedAt: null } },
      { $group: { _id: { goalId: '$goalId', userId: '$userId' }, total: { $sum: '$amountVnd' },
        recent: { $sum: { $cond: [{ $and: [{ $gte: ['$occurredOn', from] }, { $lte: ['$occurredOn', today] }] }, '$amountVnd', 0] } } } },
    ]).exec();
    const result = new Map<string, SavingsTotals>();
    for (const row of rows) {
      const id = row._id.goalId.toString();
      const total = result.get(id) ?? { totalVnd: 0, recentVnd: 0, contributions: [] };
      total.totalVnd += row.total;
      total.recentVnd += row.recent;
      total.contributions.push({ userId: row._id.userId.toString(), amountVnd: row.total });
      result.set(id, total);
    }
    return result;
  },
};
