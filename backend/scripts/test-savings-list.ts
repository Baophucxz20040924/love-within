import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { SavingsGoal } from '../src/models/SavingsGoal.js';
import { SavingsEntry } from '../src/models/SavingsEntry.js';
import { savingsRepository } from '../src/repositories/savings.repository.js';
import type { SavingsListInput } from '../src/services/savings.validation.js';
import { savingsService } from '../src/services/savings.service.js';
import type { CoupleDoc } from '../src/models/Couple.js';

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
  const period = { from: '2026-01-01', today: '2026-01-30' };
  const selected = { totalVnd: 120000, recentVnd: 40000, contributions: [{ userId: id.toString(), amountVnd: 120000 }] };
  const originalTotals = savingsRepository.totals;
  try {
    (SavingsGoal as any).aggregate = (stages: any[]) => {
      pipeline = stages;
      return { option(value: unknown) { options = value; return this; }, exec: async () => [{
        _id: id, coupleId, title: 'Goal', emoji: 'x', targetVnd: 100000,
        status: 'active', createdBy: id, createdAt: new Date(date), updatedAt: new Date(date), _entryTotals: [selected],
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
      const rows = await savingsRepository.list(coupleId, input(status), period);
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
        { $group: { _id: '$userId', total: { $sum: '$amountVnd' },
          recent: { $sum: { $cond: [{ $and: [{ $gte: ['$occurredOn', period.from] }, { $lte: ['$occurredOn', period.today] }] }, '$amountVnd', 0] } } } },
        { $group: { _id: null, totalVnd: { $sum: '$total' }, recentVnd: { $sum: '$recent' },
          contributions: { $push: { userId: { $toString: '$_id' }, amountVnd: '$total' } } } },
      ]);
      assert.deepEqual(pipeline[3].$match.$expr, { [status === 'active' ? '$lt' : '$gte']: [
        { $ifNull: [{ $arrayElemAt: ['$_entryTotals.totalVnd', 0] }, 0] }, '$targetVnd',
      ] });
      assert.deepEqual(pipeline[4], { $limit: 3 });
      assert.deepEqual(pipeline[5], { $project: { appliedProposalIds: 0 } });
      assert.deepEqual(options, { maxTimeMS: 3000, allowDiskUse: false });
      assert.deepEqual(rows[0].selectedTotals, selected);
      assert.ok(rows[0] instanceof SavingsGoal);
      assert.equal(rows[0].id, id.toString());
      assert.equal(rows[0].appliedProposalIds, undefined);
    }
    for (const status of ['all', 'open', 'closed'] as const) {
      await savingsRepository.list(coupleId, input(status), period);
      assert.deepEqual(findFilter.status, status === 'all' ? undefined : status === 'open' ? { $in: ['active', 'reached'] } : 'closed');
      assert.deepEqual(findCalls, [['select', '-appliedProposalIds'], ['sort', { createdAt: -1, _id: -1 }], ['limit', 3], ['maxTimeMS', 3000]]);
    }
    savingsRepository.totals = async () => { throw new Error('unexpected second totals query'); };
    const couple = { _id: coupleId, timezone: 'UTC', memberIds: [id] } as CoupleDoc;
    const reached = await savingsService.list(couple, { status: 'reached' });
    assert.equal(reached.items[0].status, 'reached');
    assert.equal(reached.items[0].totalVnd, selected.totalVnd);
    assert.deepEqual(reached.items[0].contributions, selected.contributions);
    assert.equal('selectedTotals' in reached.items[0], false);
    selected.totalVnd = 50000;
    selected.recentVnd = 25000;
    selected.contributions[0].amountVnd = 50000;
    const active = await savingsService.list(couple, { status: 'active' });
    assert.equal(active.items[0].status, 'active');
    assert.equal(active.items[0].totalVnd, 50000);
    assert.ok(active.items[0].forecastOn);
    assert.deepEqual(active.items[0].contributions, selected.contributions);
    console.log('savings list mocked pipeline tests passed');
  } finally {
    savingsRepository.totals = originalTotals;
    SavingsGoal.aggregate = originalAggregate;
    SavingsGoal.find = originalFind;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
