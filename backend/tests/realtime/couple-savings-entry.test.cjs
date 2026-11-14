const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./couple-test-loader.cjs');

const now = new Date('2026-01-01T00:00:00Z');
const state = { entry: null , creates: 0, events: [] , total: 0, goal: { _id: 'g1', id: 'g1', status: 'active', title: 'Goal', emoji: '', targetVnd: 1000, dueOn: null, reachedAt: null, createdBy: 'alice', createdAt: now, updatedAt: now, version: 1 }, failTotals: false };
(globalThis ).__savingsEntryTest = state;
const stubs = {
  mongoose: `export const Types = { ObjectId: class {} };`,
  '../models/Couple.js': `export const Couple = {};`,
  '../models/SavingsGoal.js': `export const SavingsGoal = {};`,
  '../models/SavingsEntry.js': `export const SavingsEntry = {
 findOne: () => ({ exec: async () => globalThis.__savingsEntryTest.entry }),
 create: async input => { const s=globalThis.__savingsEntryTest; s.creates++; s.total += input.amountVnd; return s.entry={...input, id:'e1', createdAt: new Date('2026-01-01')}; },
  };`,
  '../models/BankTransaction.js': `export const BankTransaction = {};`,
  '../models/BankConnection.js': `export const BankConnection = {};`,
  '../models/User.js': `export const User = {};`,
  '../repositories/savings.repository.js': `export const savingsRepository = {
 goal: async () => globalThis.__savingsEntryTest.goal,
 totals: async () => { const s=globalThis.__savingsEntryTest; if (s.failTotals) throw Error('totals failed'); return new Map([['g1', { totalVnd:s.total, recentVnd:0, contributions:[] }]]); },
  };`,
  '../utils/errors.js': `export class AppError extends Error { constructor(status,code,msg) { super(msg); this.status=status; this.code=code; } } export const Errors = { notFound: msg => Error(msg), badRequest: msg => Error(msg), forbidden: msg => Error(msg) };`,
  '../utils/date.js': `export const addDays = () => '2025-12-01'; export const getLocalDate = () => '2026-01-01';`,
  './notification.service.js': `export const notificationService = { emit: async () => {} };`,
  './savingsWrite.service.js': `export const withSavingsWrite = async (couple, uid, work) => { const ctx={ couple, dirty:new Set(), afterRelease:[] }; let result; try { result=await work(ctx); } finally { if(ctx.dirty.size) globalThis.__savingsEntryTest.events.push([...ctx.dirty]); } return result; };`,
  './savings.validation.js': `const schema={ parse:x=>x }; export const savingsCreateSchema=schema, savingsEntrySchema=schema, savingsListSchema=schema, savingsUpdatePayloadSchema=schema;`,
};
const { savingsService } = loadService('savings.service.ts', stubs);
const couple = { _id: 'couple-1', timezone: 'UTC', memberIds: ['alice', 'bob'], pinnedSavingsGoalId: null } ;
const input = { amountVnd: 100, occurredOn: '2026-01-01', note: '', operationId: 'op1' } ;

test('entry commit signals; same idempotency key and payload replay does not write or emit', async () => {
  state.entry = null; state.creates = 0; state.total = 0; state.events.length = 0;
  const first = await savingsService.add(couple, 'alice', 'g1', input);
  assert.equal(first.entry.amountVnd, 100); assert.equal(state.creates, 1); assert.deepEqual(state.events, [['savings']]);
  state.events.length = 0;
  const replay = await savingsService.add(couple, 'alice', 'g1', input);
  assert.equal(replay.entry.id, first.entry.id); assert.equal(state.creates, 1); assert.deepEqual(state.events, []);
  await assert.rejects(savingsService.add(couple, 'alice', 'g1', { ...input , amountVnd: 200 }), (e ) => e.code === 'SAVINGS_OPERATION_CONFLICT');
  assert.equal(state.creates, 1); assert.deepEqual(state.events, []);
});
