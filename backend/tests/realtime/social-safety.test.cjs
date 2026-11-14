'use strict';
// Block/unblock persistence ordering with mocked repositories, no dotenv or database.
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
const filename = path.resolve(__dirname, '../../src/services/friendSafety.service.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const id = (v) => ({ toString: () => v, equals: (other) => v === other.toString() });
const actor = id('actor'), target = id('target');
let calls = [], mode = '', captures = 0;
const mocks = {
  '../models/FriendSafety.js': {},
  '../repositories/friendship.repository.js': { friendshipRepository: { deleteBetween: async () => { calls.push('delete'); if (mode === 'delete-fail') throw Error('delete failed'); } } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { block: async () => { calls.push('block'); if (mode === 'block-fail') throw Error('block failed'); }, isBlockedBy: async () => mode !== 'absent', unblock: async () => { calls.push('unblock'); return true; } }, friendHiddenStoryRepository: {}, friendReportRepository: {} },
  '../repositories/friendEvent.repository.js': {}, '../repositories/friendStory.repository.js': {},
  '../repositories/user.repository.js': { userRepository: { findById: async () => ({ _id: target, friendsJoinedAt: new Date() }) } },
  '../utils/errors.js': { Errors: { badRequest: () => Error('bad'), notFound: () => Error('not found') } },
  '../utils/logger.js': { logger: { info() {} } }, './friendEvent.service.js': {}, './friendStory.service.js': {},
  './notification.service.js': { notificationService: { forgetBetween: async () => calls.push('forget') } },
  './realtimeAudience.service.js': {}, './friendOuting.service.js': { captureRelationshipAudience: async () => { calls.push('capture'); captures++; return mode === 'unblock-success' && captures === 2 ? ['actor', 'target', 'newly-eligible'] : ['actor', 'target', 'third']; }, invalidateRelationshipAudience: (ids, access) => calls.push(['hint', Array.from(ids), access]) },
  './profile.service.js': {},
};
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
const svc = mod.exports.friendSafetyService;
(async () => {
  mode = 'block-fail';
  await assert.rejects(svc.block({ _id: actor }, 'target'), /block failed/);
  assert.deepEqual(calls, ['capture', 'block'], 'no hint before failed write');
  calls = []; mode = 'delete-fail';
  await assert.rejects(svc.block({ _id: actor }, 'target'), /delete failed/);
  assert.deepEqual(calls, ['capture', 'block', ['hint', ['actor', 'target', 'third'], true], 'delete'], 'persisted block signalled even if cleanup fails');
  calls = []; mode = 'absent';
  await assert.rejects(svc.unblock({ _id: actor }, 'target'));
  assert.deepEqual(calls, [], 'missing block does not write or hint');
  calls = []; mode = 'delete-fail';
  await assert.rejects(svc.unblock({ _id: actor }, 'target'), /delete failed/);
  assert.deepEqual(calls, ['capture', 'delete'], 'unblock never proceeds after cleanup failure');
  calls = []; captures = 0; mode = 'unblock-success';
  await svc.unblock({ _id: actor }, 'target');
  assert.deepEqual(calls, ['capture', 'delete', ['hint', ['actor', 'target', 'third'], true], 'unblock', 'capture', ['hint', ['actor', 'target', 'third', 'newly-eligible'], true]], 'unblock also signals newly eligible after-state viewers');
  console.log('PASS social safety: failed writes, partial block and unblock audience');
})().catch((error) => { console.error(error); process.exitCode = 1; });
