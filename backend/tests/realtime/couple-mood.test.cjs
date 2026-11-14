// Node 22+ standalone behavior test. Its ESM loader substitutes all imports so this
// test does not load dotenv, providers, a database, or the real realtime transport.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./couple-test-loader.cjs');

const events = [];
let failWrite = false;
const state = globalThis ;
state.__coupleMoodTest = {
  events,
  persist: async (input ) => {
 if (failWrite) throw new Error('write rejected');
 return { ...input, updatedAt: new Date('2026-01-01T00:00:00Z') };
  },
};
const stubs = {
  './realtimeAudience.service.js': `export const realtimeAudience = { couple: async (...args) => globalThis.__coupleMoodTest.events.push(args) };`,
  mongoose: `export const Types = { ObjectId: class ObjectId { constructor(id) { this.id = id } toString() { return this.id } } };`,
  '../repositories/nudge.repository.js': `export const moodRepository = { upsertDay: (...args) => globalThis.__coupleMoodTest.persist(...args) };`,
  '../utils/date.js': `export const getLocalDate = () => '2026-01-01'; export const addDays = () => '2026-01-01';`,
  '../utils/logger.js': `export const logger = { debug() {} };`,
};
const { moodService } = loadService('mood.service.ts', stubs);
const couple = { _id: 'couple-1', timezone: 'UTC' } ;

for (const scenario of [
  { name: 'persisted mood reaches couple audience', fail: false, expectedEvents: 1 },
  { name: 'rejected persistence sends no invalidation', fail: true, expectedEvents: 0 },
]) {
  test(scenario.name, async () => {
 events.length = 0;
 failWrite = scenario.fail;
 const operation = moodService.setToday(couple, 'user-1', { mood: 'happy', note: ' private ' });
 if (scenario.fail) await assert.rejects(operation, /write rejected/);
 else assert.equal((await operation).note, 'private');
 assert.equal(events.length, scenario.expectedEvents);
 if (!scenario.fail) assert.deepEqual(events[0], ['couple-1', ['moods']]);
  });
}
