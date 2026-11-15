'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const members = [new Types.ObjectId(), new Types.ObjectId()];
const couple = { _id: new Types.ObjectId(), memberIds: members, timezone: 'UTC' };
const query = fn => ({ exec: async () => fn() });
let day, row, failPayment = false;
const payments = new Map();
const definition = { key: 'duo_moment', type: 'duo_moment', title: 'Khoảnh khắc đôi', description: 'old catalog copy', active: true, coinReward: 10, expReward: 5 };
const repository = {
  listActive: async () => [definition], findByKey: async () => definition,
  ensureProgress: async () => row,
  setProgress: async (_c, _k, _d, progress, target) => {
    if (row.status === 'rewarded' || row.progress > progress) return null;
    Object.assign(row, { progress, target, status: progress >= target ? 'completed' : 'in_progress' }); return row;
  },
  findOne: async () => row,
  markRewarded: async (_c, _k, _d, _u, rewardIntent) => {
    if (row.status !== 'completed') return null;
    Object.assign(row, { status: 'rewarded', rewardIntent }); return row;
  },
};
const load = loader({ ...quiet,
  'models/Quest.ts': { QuestProgress: { updateOne: () => query(() => { row.rewardCompletedAt = new Date(); }) } },
  'repositories/quest.repository.ts': { questRepository: repository },
  'repositories/checkin.repository.ts': {}, 'repositories/coupleSettings.repository.ts': {},
  'repositories/question.repository.ts': {},
  'repositories/moment.repository.ts': { momentRepository: { findDay: async () => day } },
  'services/wallet.service.ts': { walletService: { reward: async intent => {
    if (!payments.has(intent.operationId)) payments.set(intent.operationId, intent);
    if (failPayment) { failPayment = false; throw Error('unknown payment outcome'); }
  } } },
});
const service = load('services/quest.service.ts').questService;
const { splitCoin } = load('repositories/wallet.repository.ts');
const start = new Date('2026-11-15T10:00:00Z');
const deadline = new Date('2026-11-15T10:30:00Z');
function reset(version, times) {
  payments.clear();
  row = { _id: new Types.ObjectId(), status: 'in_progress', localDate: '2026-11-15', progress: 0, target: 2 };
  const posts = times.map((postedAt, i) => ({ userId: members[i], postedAt: new Date(postedAt), lateMin: 0 }));
  day = version === 1 ? { promptAt: start, posts } : { scheduleVersion: version, sessions: [{ promptAt: start, rewardEndsAt: deadline, closesAt: new Date('2026-11-16T00:00:00Z'), posts }] };
}
(async () => {
  reset(3, ['2026-11-15T10:00:00Z', '2026-11-15T10:29:59.999Z']);
  let view = (await service.getToday(couple))[0];
  assert.equal(view.coinReward, 40); assert.equal(view.status, 'completed'); assert.match(view.description, /30 phút/);
  failPayment = true;
  await assert.rejects(service.claim(couple, String(members[0]), 'duo_moment'), /unknown/);
  const frozen = row.rewardIntent;
  view = await service.claim(couple, String(members[1]), 'duo_moment');
  assert.equal(row.rewardIntent, frozen); assert.equal(payments.size, 1);
  assert.equal(view.coinReward, 40); assert.equal(frozen.exp, 5); assert.equal(frozen.ownerUserId, null);
  assert.deepEqual(Object.values(splitCoin(frozen.coin, members.map(String))), [20, 20]);
  for (const times of [
    ['2026-11-15T10:01:00Z', '2026-11-15T10:30:00Z'],
    ['2026-11-15T22:00:00Z', '2026-11-15T23:59:59Z'],
  ]) {
    reset(3, times);
    const { momentProgress } = load('models/DuoMoment.ts');
    assert.equal(momentProgress(day, members), 2, 'late pair still preserves streak');
    await assert.rejects(service.claim(couple, String(members[0]), 'duo_moment'), e => e.status === 409);
    assert.equal(payments.size, 0);
  }
  for (const version of [1, 2]) {
    reset(version, ['2026-11-15T10:01:00Z', '2026-11-15T10:02:00Z']);
    view = await service.claim(couple, String(members[0]), 'duo_moment');
    assert.equal(view.coinReward, 10, 'existing days never receive retroactive 40');
  }
  reset(3, ['2026-11-15T10:01:00Z', '2026-11-15T10:02:00Z']);
  row.status = 'rewarded';
  row.rewardIntent = { operationId: `quest:${row._id}`, actorUserId: String(members[0]), ownerUserId: null, coin: 10, exp: 5 };
  view = await service.claim(couple, String(members[1]), 'duo_moment');
  assert.equal(view.coinReward, 10); assert.equal(payments.values().next().value.coin, 10);

  // Exercise the real repository's stale-refresh filter, not the service mock above.
  let captured;
  const repo = loader({ 'models/Quest.ts': { QuestProgress: { findOneAndUpdate: (filter) => { captured = filter; return query(() => null); } } } })('repositories/quest.repository.ts').questRepository;
  await repo.setProgress(couple._id, 'duo_moment', '2026-11-15', 1, 2);
  assert.equal(captured.progress.$lte, 1); assert.equal(captured.status.$ne, 'rewarded');
  await repo.setProgress(couple._id, 'drink_water', '2026-11-15', 1, 2);
  assert.equal(captured.progress, undefined, 'other quest types can still decrease');
  console.log('PASS daily moment rewards: timely40 split20/20, late streak without reward, immutable legacy intents, stale refresh guard');
})().catch(error => { console.error(error); process.exitCode = 1; });
