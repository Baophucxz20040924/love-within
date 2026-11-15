'use strict';
// Exercise event RSVP writes with mocked repositories and a modeled audience adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
for (let dir = __dirname; ; dir = path.dirname(dir)) {
  for (const base of [dir, path.join(dir, 'backend'), path.join(dir, 'frontend')]) {
    try { ts = require(require.resolve('typescript', { paths: [base] })); break; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  if (ts) break;
  if (path.dirname(dir) === dir) throw Error('Installed TypeScript not found');
}
const filename = path.resolve(__dirname, '../../src/services/friendEvent.service.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const id = (v) => ({ toString: () => v, equals: (x) => v === x.toString() });
const creator = id('creator'), going = id('going'), pending = id('pending'), declined = id('declined'), blocked = id('blocked');
const ev = { _id: id('event'), creatorId: creator, inviteeIds: [going, pending, declined, blocked], hiddenByReportsAt: null, rsvps: new Map([['declined', 'declined']]), status: 'active', pastAt: new Date(Date.now() + 3600000), startAt: new Date(), endAt: null, createdAt: new Date(), cover: null };
let calls = [], canSee = true, failWrite = false;
const key = (a, b) => [a.toString(), b.toString()].sort().join(':');
const allowed = new Set(['going', 'pending', 'declined']);
const mocks = {
  'node:crypto': {}, mongoose: { Types: {} }, '../config/env.js': {}, '../models/FriendEvent.js': {},
  '../integrations/index.js': {},
  '../repositories/friendEvent.repository.js': { friendEventRepository: { findById: async () => ev, setRsvp: async () => { if (failWrite) throw Error('write failed'); calls.push('write'); return ev; } }, friendEventCommentRepository: {} },
  '../repositories/friendship.repository.js': { pairKeyOf: key, friendshipRepository: { areFriends: async () => canSee, acceptedUnblockedPairKeys: async (pairs) => new Set(pairs.filter((p) => allowed.has(p[1].toString())).map((p) => key(...p))) } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async () => false, blockedIdsFor: async () => new Set() } },
  '../utils/date.js': {}, '../utils/errors.js': { AppError: Error, Errors: { notFound: () => Error('not found'), conflict: () => Error('conflict') } },
  '../utils/logger.js': { logger: {} },
  './notification.service.js': { notificationService: { emit: async () => calls.push('push'), forgetActor: async () => calls.push('forget') } },
  './realtimeAudience.service.js': { realtimeAudience: { event: async (doc, domains) => { calls.push(['event', [doc.creatorId, ...doc.inviteeIds.filter((x) => allowed.has(x.toString()))].map(String), Array.from(domains)]); }, own: async () => calls.push('own') } },
  './profile.service.js': { profileOf: () => ({}), profileService: { load: async () => new Map() } }, './story.service.js': {},
  './mentionSpans.js': {}, './friends.service.js': {}, '../repositories/user.repository.js': {},
};
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
(async () => {
  await mod.exports.friendEventService.rsvp({ _id: going }, 'event', 'going');
  assert.equal(calls[0], 'write');
  assert.deepEqual(calls[1], ['event', ['creator', 'going', 'pending', 'declined'], ['friend-events']]);
  assert.equal(calls[2], 'push');
  calls = []; canSee = false;
  await assert.rejects(mod.exports.friendEventService.rsvp({ _id: going }, 'event', 'declined'));
  assert.deepEqual(calls, [], 'inaccessible events do not write or signal');
  canSee = true; failWrite = true;
  await assert.rejects(mod.exports.friendEventService.rsvp({ _id: going }, 'event', 'declined'), /write failed/);
  assert.deepEqual(calls, [], 'failed persistence is not signalled');
  console.log('PASS social event: RSVP write passes full audience, denial and failed write');
})().catch((error) => { console.error(error); process.exitCode = 1; });
