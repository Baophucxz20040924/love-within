'use strict';
// Exercise the actual service with mocked repositories and publisher; no env, database or provider.
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
  if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
}
function load(relative, mocks) {
  const filename = path.resolve(__dirname, '../../src/services', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
const id = (value) => ({ toString: () => value, equals: (other) => value === other.toString() });
const to = id('recipient'), actor = id('actor'), entity = id('post');
let calls = [], blocked = false, groupedNew = false, failStore = false;
const repo = {
  add: async () => { if (failStore) throw Error('store'); calls.push('add'); },
  addGrouped: async () => { if (failStore) throw Error('store'); calls.push('group'); return groupedNew; },
  ownersForEntities: async () => [to], deleteForEntity: async () => calls.push('delete'),
  deleteForEntityOfType: async () => calls.push('delete'), deleteForEntities: async () => calls.push('delete'),
  removeGroupedActor: async () => calls.push('removeActor'), purgeBetween: async () => calls.push('purge'),
};
const own = async (...args) => calls.push(JSON.parse(JSON.stringify(['own', ...args])));
const { notificationService } = load('notification.service.ts', {
  mongoose: { Types: { ObjectId: function ObjectId() {} } },
  '../config/notificationTypes.js': { COUPLE_PUSH_RULES: {}, FRIENDS_PUSH_RULES: { story_reaction: { onlyNewActor: true }, friend_accepted: {} } },
  '../models/FriendNotification.js': { GROUPED_NOTIFICATION_TYPES: new Set(['story_reaction']), OUTING_NOTIFICATION_TYPES: new Set(), SYSTEM_NOTIFICATION_TYPES: new Set() },
  '../repositories/friendNotification.repository.js': { friendNotificationRepository: repo },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async () => blocked } },
  '../utils/logger.js': { logger: { warn() {} } },
  './push.service.js': { pushService: { enqueue: () => calls.push('push') } },
  './realtimeAudience.service.js': { realtimeAudience: { own } },
});
(async () => {
  const input = { space: 'friends', to, type: 'story_reaction', actorId: actor, entityId: entity };
  await notificationService.emit(input);
  assert.equal(calls[0], 'group');
  assert.deepEqual(calls[1], ['own', 'recipient', 'friends', ['friend-notifications']]);
  assert.equal(calls.includes('push'), false, 'grouped repeat updates stored row despite suppressed push');
  calls = []; groupedNew = true;
  await notificationService.emit(input);
  assert.equal(calls.includes('push'), true);
  calls = []; blocked = true;
  await notificationService.emit(input);
  assert.deepEqual(calls, [], 'blocked action is not persisted or signalled');
  blocked = false; failStore = true;
  await notificationService.emit(input);
  assert.deepEqual(calls, [], 'failed persistence is not signalled');
  failStore = false; calls = [];
  await notificationService.forgetEntity(entity);
  assert.equal(calls[0], 'delete');
  assert.deepEqual(calls[1], ['own', 'recipient', 'friends', ['friend-notifications']]);
  calls = [];
  await notificationService.forgetActor(to, 'story_reaction', entity, actor);
  assert.equal(calls[0], 'removeActor');
  assert.deepEqual(calls[1], ['own', 'recipient', 'friends', ['friend-notifications']]);
  console.log('PASS social notifications: grouped, suppression, ACL, failed write and removal');
})().catch((error) => { console.error(error); process.exitCode = 1; });
