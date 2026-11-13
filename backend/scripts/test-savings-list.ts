import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { SavingsGoal } from '../src/models/SavingsGoal.js';
import { SavingsEntry } from '../src/models/SavingsEntry.js';
import { savingsRepository } from '../src/repositories/savings.repository.js';
import type { SavingsListInput } from '../src/services/savings.validation.js';

// Pure mocks only: this script never connects to a database.
async function main() {
  const coupleId = new Types.ObjectId('111111111111111111111111');
  const id = new Types.ObjectId('222222222222222222222222');
  const date = '2026-01-01T00:00:00.000Z';
  const originalAggregate = SavingsGoal.aggregate;
  const originalFind = SavingsGoal.find;
  let pipeline: any[] = [];
  let options: unknown;
  let findFilter: any;
  let findCalls: unknown[] = [];
  try {
    (SavingsGoal as any).aggregate = (stages: any[]) => {
      pipeline = stages;
      return { option(value: unknown) { options = value; return this; }, exec: async () => [{
        _id: id, coupleId, title: 'Goal', emoji: 'x', targetVnd: 100000,
        status: 'active', createdBy: id, createdAt: new Date(date), updatedAt: new Date(date),
      }] };
    };
    (SavingsGoal as any).find = (filter: unknown) => {
      findFilter = filter;
      findCalls = [];
      const query = {
        select(value: unknown) { findCalls.push(['select', value]); return this; },
        sort(value: unknown) { findCalls.push(['sort', value]); return this; },
        limit(value: unknown) { findCalls.push(['limit', value]); return this; },
        maxTimeMS(value: unknown) { findCalls.push(['maxTimeMS', value]); return this; },
        exec: async () => [],
      };
      return query;
    };
    const input = (status: SavingsListInput['status']): SavingsListInput => ({
      status, limit: 2, q: 'a.*[b]\\', cursor: `${date}_${id}`,
    });
    for (const status of ['active', 'reached'] as const) {
      const rows = await savingsRepository.list(coupleId, input(status));
      assert.deepEqual(pipeline.map((stage) => Object.keys(stage)[0]),
        ['$match', '$sort', '$lookup', '$match', '$limit', '$project']);
      assert.deepEqual(pipeline[0].$match, {
        coupleId, status: { $in: ['active', 'reached'] },
        title: { $regex: 'a\\.\\*\\[b\\]\\\\', $options: 'i' },
        $or: [{ createdAt: { $lt: new Date(date) } }, { createdAt: new Date(date), _id: { $lt: id } }],
      });
      assert.deepEqual(pipeline[1], { $sort: { createdAt: -1, _id: -1 } });
      assert.equal(pipeline[2].$lookup.from, SavingsEntry.collection.name);
      assert.deepEqual(pipeline[2].$lookup.let, { goalId: '$_id' });
      assert.deepEqual(pipeline[2].$lookup.pipeline, [
        { $match: { coupleId, deletedAt: null, $expr: { $eq: ['$goalId', '$$goalId'] } } },
        { $group: { _id: null, totalVnd: { $sum: '$amountVnd' } } },
      ]);
      assert.deepEqual(pipeline[3].$match.$expr, { [status === 'active' ? '$lt' : '$gte']: [
        { $ifNull: [{ $arrayElemAt: ['$_entryTotals.totalVnd', 0] }, 0] }, '$targetVnd',
      ] });
      assert.deepEqual(pipeline[4], { $limit: 3 });
      assert.deepEqual(pipeline[5], { $project: { _entryTotals: 0, appliedProposalIds: 0 } });
      assert.deepEqual(options, { maxTimeMS: 3000 });
      assert.ok(rows[0] instanceof SavingsGoal);
      assert.equal(rows[0].id, id.toString());
      assert.equal(rows[0].appliedProposalIds, undefined);
    }
    for (const status of ['all', 'open', 'closed'] as const) {
      await savingsRepository.list(coupleId, input(status));
      assert.deepEqual(findFilter.status, status === 'all' ? undefined : status === 'open' ? { $in: ['active', 'reached'] } : 'closed');
      assert.deepEqual(findCalls, [['select', '-appliedProposalIds'], ['sort', { createdAt: -1, _id: -1 }], ['limit', 3], ['maxTimeMS', 3000]]);
    }
    console.log('savings list mocked pipeline tests passed');
  } finally {
    SavingsGoal.aggregate = originalAggregate;
    SavingsGoal.find = originalFind;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
