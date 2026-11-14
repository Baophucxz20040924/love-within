'use strict';
// Exercise before-audience capture and generic revocation without a database.
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
const filename = path.resolve(__dirname, '../../src/services/friendOuting.service.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const id = (x) => ({ toString: () => x });
const a = '000000000000000000000001', b = '000000000000000000000002';
let calls = [];
const mocks = {
  mongoose: { Types: { ObjectId: class ObjectId { constructor(value) { if (!/^[a-f0-9]{24}$/.test(value)) throw Error('bad id'); this.value = value; } toString() { return this.value; } } } }, '../models/FriendOuting.js': {},
  '../repositories/friendOuting.repository.js': { friendOutingRepository: { affectedByRelationship: async () => [{ creatorId: a, participants: [{ userId: a, status: 'accepted' }, { userId: b, status: 'accepted' }, { userId: 'historical', status: 'accepted' }, { userId: 'eligible', status: 'pending' }, { userId: 'ineligible', status: 'declined' }] }] } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { blockedIdsFor: async () => new Set(['blocked']) } },
  '../repositories/friendship.repository.js': { friendshipRepository: { friendIds: async (u) => u.toString() === a ? [id('network'), id('blocked')] : [] } },
  '../utils/errors.js': {}, '../utils/logger.js': {}, './friendEvent.service.js': {}, './profile.service.js': {},
  './realtimeAudience.service.js': {}, './realtime.service.js': { realtimeService: { publish: (ids, space, domains, access) => calls.push([Array.from(ids), space, Array.from(domains), access]) } },
  './friendSuggestion.service.js': { invalidateSuggestionCache: (ids) => calls.push(['cache', ...ids]) },
  './friendOuting.views.js': { outingInvitationEligible: async (_doc, userId) => userId === 'eligible' },
  './friendOuting.mutations.js': {}, './friendOuting.validation.js': {},
};
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
(async () => {
  const ids = Array.from(await mod.exports.captureRelationshipAudience(a, b));
  assert.deepEqual(ids.sort(), [a, b, 'eligible', 'historical', 'network']);
  mod.exports.invalidateRelationshipAudience(ids, true);
  assert.equal(calls[0][0], 'cache');
  assert.deepEqual(calls[1], [ids, 'friends', ['friends'], true]);
  assert.equal(JSON.stringify(calls[1]).includes('ineligible'), false);
  console.log('PASS social relationship: before-viewers, historical outings, blocked and generic access reset');
})().catch((error) => { console.error(error); process.exitCode = 1; });
