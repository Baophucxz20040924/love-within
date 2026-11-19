'use strict';
// Source modules with fail-closed fake persistence. No server, environment or provider imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.argv[2] || 'typescript');
const root = path.resolve(__dirname, '../../src');
const normalize = x => JSON.parse(JSON.stringify(x));
function load(relative, overrides) {
  const filename = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  const requireSafe = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    throw Error(`Unexpected import ${name}`);
  };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: requireSafe, Date, Number, Map, Set, Object, process: { memoryUsage() { throw Error('unexpected'); } } }, { filename });
  return mod.exports;
}
let clock = 0;
const monitor = load('utils/monitor.ts', {
  'node:perf_hooks': { performance: { now: () => ++clock }, monitorEventLoopDelay() { throw Error('unexpected'); } },
  mongoose: { default: { connection: {} } },
  '../config/env.js': { env: {} }, '../utils/logger.js': {}, './logger.js': { logger: {} },
});
const query = fn => ({ exec: async () => fn() });
const error = Error('fixture failure');
let data, calls, story, take, daily, couple;
const source = name => ({
  find: () => ({ sort: () => ({ limit: n => { assert.equal(n, 20); return query(() => { calls.push(`query:${name}`); if (data[name] === error) throw error; return data[name]; }); } }) }),
  updateOne: () => query(() => { calls.push(`complete:${name}`); return { modifiedCount: 1 }; }),
});
const overrides = {
  'node:crypto': require('node:crypto'), mongoose: { Types: {} },
  './realtimeAudience.service.js': {}, '../config/economy.js': { ECONOMY: { bucket: { maxRewardsPerDay: 3 } } },
  '../models/Couple.js': { Couple: { findById: () => query(() => { calls.push('couple'); if (couple === error) throw error; return couple; }) } },
  '../models/Checkin.js': { Checkin: source('checkin') }, '../models/Quest.js': { QuestProgress: source('quest') },
  '../models/BucketItem.js': { BucketItem: source('bucket') },
  '../repositories/bucket.repository.js': { bucketRewardDayRepository: { take: async () => { calls.push('take'); return take; } } },
  './bucketCompletion.service.js': { finishBucketCompletion: async () => { calls.push('story'); if (story === error) throw error; return story; } },
  './dailyReward.service.js': { dailyRewardService: { recoverCouple: async () => { calls.push('daily'); if (daily === error) throw error; } } },
  '../repositories/wallet.repository.js': { walletReview: () => error }, '../utils/errors.js': {}, '../utils/monitor.js': monitor,
  '../utils/historyCursor.js': { decodeHistoryCursor() { throw Error('unexpected pagination'); }, encodeHistoryCursor() { throw Error('unexpected pagination'); } },
};
const service = load('services/wallet.service.ts', overrides).walletService;
service.reward = async () => { calls.push('reward'); if (data.reward === error) throw error; };
function reset() { data = { checkin: [], quest: [], bucket: [] }; calls = []; story = true; take = true; daily = null; couple = {}; }
const row = i => ({ _id: i, rewardIntent: { operationId: String(i), localDate: 'fixture' } });
function snapshot() { return normalize(monitor.operationMetricsSnapshot()); }
function delta(before, stage, key) { return (snapshot().recoveryCounts[stage]?.[key] || 0) - (before.recoveryCounts[stage]?.[key] || 0); }
function timing(before, stage, outcome) { const key = `recovery.${stage}.${outcome}`; return (snapshot().timings[key]?.count || 0) - (before.timings[key]?.count || 0); }
(async () => {
  reset(); let before = snapshot(); await service.recoverRewards('fixture');
  assert.deepEqual(calls, ['query:checkin', 'query:quest', 'query:bucket', 'couple', 'daily']);
  for (const stage of ['checkin', 'quest', 'bucket']) assert.equal(timing(before, stage, 'empty'), 1);
  assert.equal(timing(before, 'daily', 'ok'), 1); assert.equal(delta(before, 'daily', 'terminal'), 0);
  assert.equal(timing(before, 'whole', 'ok'), 1);
  reset(); data.checkin = [row(1)]; data.quest = [row(2)]; data.bucket = [row(3)]; before = snapshot(); await service.recoverRewards('fixture');
  assert.deepEqual(calls, ['query:checkin', 'reward', 'complete:checkin', 'query:quest', 'reward', 'complete:quest', 'query:bucket', 'couple', 'story', 'take', 'reward', 'complete:bucket', 'couple', 'daily']);
  assert.equal(delta(before, 'whole', 'examined'), 3); assert.equal(delta(before, 'whole', 'terminal'), 3);
  reset(); data.checkin = Array.from({ length: 20 }, (_, i) => row(i)); before = snapshot(); await service.recoverRewards('fixture');
  assert.equal(delta(before, 'checkin', 'saturated'), 1); assert.equal(delta(before, 'checkin', 'examined'), 20);
  reset(); data.bucket = [row(1)]; story = false; before = snapshot(); await service.recoverRewards('fixture');
  assert.equal(delta(before, 'bucket', 'deferred'), 1); assert.equal(delta(before, 'bucket', 'errors'), 0); assert.equal(timing(before, 'whole', 'partial'), 1);
  reset(); data.bucket = [row(1)]; story = error; before = snapshot(); await service.recoverRewards('fixture');
  assert.equal(delta(before, 'bucket', 'deferred'), 1); assert.equal(delta(before, 'bucket', 'errors'), 1); assert.equal(timing(before, 'bucket', 'partial'), 1);
  assert.ok(calls.includes('daily'));
  reset(); data.bucket = [row(1)]; take = false; before = snapshot(); await service.recoverRewards('fixture');
  assert.equal(delta(before, 'bucket', 'terminal'), 1); assert.ok(!calls.includes('reward'));
  reset(); data.quest = error; before = snapshot(); await assert.rejects(service.recoverRewards('fixture'), e => e === error);
  assert.equal(timing(before, 'quest', 'error'), 1); assert.equal(timing(before, 'whole', 'error'), 1); assert.ok(!calls.includes('query:bucket'));
  reset(); daily = error; before = snapshot(); await assert.rejects(service.recoverRewards('fixture'), e => e === error);
  assert.equal(timing(before, 'daily', 'error'), 1); assert.equal(delta(before, 'whole', 'errors'), 1);
  reset(); couple = null; before = snapshot(); await service.recoverRewards('fixture'); assert.equal(timing(before, 'daily', 'empty'), 1);
  before = snapshot(); const counts = { examined: 1, terminal: 0, deferred: 0, errors: 0, saturated: 0 };
  for (const args of [['secret', 'ok', 1, counts], ['checkin', 'secret', 1, counts], ['checkin', 'ok', NaN, counts], ['checkin', 'ok', -1, counts], ['checkin', 'ok', 1, { ...counts, examined: Infinity }], ['checkin', 'ok', 1, { ...counts, errors: -1 }]]) monitor.observeRecovery(...args);
  assert.deepEqual(snapshot(), before);
  const exposed = monitor.operationMetricsSnapshot(); exposed.bucketUpperBoundsMs[0] = -1; exposed.recoveryCounts.whole.examined = -1; exposed.timings['recovery.whole.ok'].buckets[0] = -1;
  assert.deepEqual(snapshot(), before); assert.ok(Object.keys(before.timings).length <= before.maxSeries);
  for (const [key, value] of Object.entries(before.timings)) { assert.match(key, /^recovery\.(whole|checkin|quest|bucket|daily)\.(ok|empty|partial|error)$/); for (const n of [value.count, value.totalMs, value.maxMs, ...value.buckets]) assert.ok(Number.isFinite(n) && n >= 0); }
  // Even a broken telemetry implementation must not alter recovery or its thrown error.
  const throwing = { ...overrides, '../utils/monitor.js': { recoveryNow() { throw error; }, observeRecovery() { throw error; } } };
  const isolated = load('services/wallet.service.ts', throwing).walletService; reset(); await isolated.recoverRewards('fixture'); reset(); data.checkin = error; await assert.rejects(isolated.recoverRewards('fixture'), e => e === error);
  console.log('PASS recovery metrics: bounded stages, outcomes, counts, privacy and failure isolation');
})().catch(err => { console.error(err); process.exitCode = 1; });
