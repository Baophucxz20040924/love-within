const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./couple-test-loader.cjs');

class TestAppError extends Error {
  status ;
  code ;
  constructor(status , code , message ) { super(message); this.status = status; this.code = code; }
}
const state = { held: false, releaseResult: 1, events: [] , order: [] , AppError: TestAppError };
(globalThis ).__savingsLockTest = state;
const stubs = {
  './realtimeAudience.service.js': `export const realtimeAudience = { couple: async (...args) => { const s = globalThis.__savingsLockTest; if (s.held) throw Error('published while locked'); s.order.push('publish'); s.events.push(args); } };`,
  '../models/Couple.js': `export const Couple = {
 findOneAndUpdate: () => ({ exec: async () => { const s = globalThis.__savingsLockTest; s.held = true; s.order.push('acquire'); return { _id: 'couple-1' }; } }),
 updateOne: () => ({ exec: async () => { const s = globalThis.__savingsLockTest; s.order.push('release'); if (s.releaseResult) s.held = false; return { modifiedCount: s.releaseResult }; } }),
 exists: async () => true,
  };`,
  '../utils/errors.js': `export const AppError = globalThis.__savingsLockTest.AppError; export const Errors = { notFound: msg => new AppError(404, 'NOT_FOUND', msg) };`,
  '../utils/logger.js': `export const logger = { warn() {}, error() {} };`,
  '../utils/monitor.js': `export const observeSavingsWrite = () => {};`,
};
const { withSavingsWrite } = loadService('savingsWrite.service.ts', stubs);
const couple = { _id: 'couple-1' } ;
function reset() { state.held = false; state.releaseResult = 1; state.events.length = 0; state.order.length = 0; }

test('committed dirty savings and proposal domains publish once after release', async () => {
  reset();
  const result = await withSavingsWrite(couple, 'alice', async ctx => {
 assert.equal(state.held, true);
 ctx.dirty.add('savings'); ctx.dirty.add('proposals'); ctx.dirty.add('savings');
 ctx.afterRelease.push(async () => { assert.equal(state.held, false); state.order.push('notify'); });
 return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(state.order, ['acquire', 'release', 'publish', 'notify']);
  assert.deepEqual(state.events, [['couple-1', ['savings', 'proposals']]]);
});

test('replay without new persisted effects emits nothing', async () => {
  reset();
  assert.equal(await withSavingsWrite(couple, 'alice', async () => 'existing'), 'existing');
  assert.deepEqual(state.order, ['acquire', 'release']); assert.deepEqual(state.events, []);
});

test('acknowledged partial work followed by known rejection signals after release', async () => {
  reset();
  await assert.rejects(withSavingsWrite(couple, 'alice', async ctx => {
 ctx.dirty.add('proposals'); throw new TestAppError(409, 'CONFLICT', 'known conflict');
  }), /known conflict/);
  assert.deepEqual(state.order, ['acquire', 'release', 'publish']);
  assert.deepEqual(state.events, [['couple-1', ['proposals']]]);
});

test('unknown outcome keeps lock for recovery and never publishes', async () => {
  reset();
  await assert.rejects(withSavingsWrite(couple, 'alice', async ctx => { ctx.dirty.add('savings'); throw Error('ambiguous'); }), (e ) => e.code === 'SAVINGS_RECOVERY_REQUIRED');
  assert.equal(state.held, true); assert.deepEqual(state.order, ['acquire']); assert.deepEqual(state.events, []);
});

test('failed token release never publishes', async () => {
  reset(); state.releaseResult = 0;
  await assert.rejects(withSavingsWrite(couple, 'alice', async ctx => { ctx.dirty.add('savings'); }), (e ) => e.code === 'SAVINGS_BUSY');
  assert.equal(state.held, true); assert.deepEqual(state.events, []);
});
