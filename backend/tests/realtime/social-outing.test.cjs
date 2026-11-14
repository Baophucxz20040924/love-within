'use strict';
// Actual outing service, with CAS, ACL and publisher dependencies mocked.
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
const actor = '000000000000000000000001', other = '000000000000000000000002', pending = '000000000000000000000003';
class ObjectId { constructor(value = '000000000000000000000010') { this.value = value; } toString() { return this.value; } equals(x) { return this.value === x.toString(); } }
const base = () => ({ _id: new ObjectId(), creatorId: actor, revision: 1, financeRevision: 1, receipts: [], participants: [{ userId: actor, status: 'accepted' }, { userId: other, status: 'accepted' }, { userId: pending, status: 'pending' }], phase: 'collecting', ordinaryOperations: 0, reservedOperations: 0 });
let stored, mode, calls, mismatch;
const error = (message) => Object.assign(Error(message), { status: 409 });
const repo = {
  find: async () => structuredCloneRecord(stored), findCreate: async () => stored && structuredCloneRecord(stored),
  create: async (doc) => { calls.push('create'); stored = structuredCloneRecord(doc); if (mode === 'ambiguous') throw Error('ack lost'); },
  compareAndSwap: async (_revision, doc) => { calls.push('cas'); if (mode === 'fail') return false; stored = structuredCloneRecord(doc); if (mode === 'ambiguous') throw Error('ack lost'); return true; },
};
function structuredCloneRecord(doc) { return { ...doc, _id: new ObjectId(doc._id.toString()), participants: doc.participants.map((p) => ({ ...p })), receipts: doc.receipts.map((r) => ({ ...r })) }; }
const mocks = {
  mongoose: { Types: { ObjectId } }, '../models/FriendOuting.js': { OUTING_LIMITS: { ordinaryBytes: 100, participants: 50 } },
  '../repositories/friendOuting.repository.js': { friendOutingRepository: repo, assertOutingCapacity() {}, outingBsonBytes: () => 1 },
  '../repositories/friendSafety.repository.js': {}, '../repositories/friendship.repository.js': { friendshipRepository: { listBetween: async (_creator, ids) => ids.map(() => ({ status: 'accepted' })) } },
  '../utils/errors.js': { AppError: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }, Errors: { notFound: () => error('not found'), badRequest: () => error('bad'), forbidden: () => error('forbidden') } },
  '../utils/logger.js': { logger: { warn() {} } }, './friendEvent.service.js': {},
  './realtimeAudience.service.js': { realtimeAudience: { outing: async (doc, domains) => { calls.push(['outing', doc.participants.map((p) => p.userId).join(','), Array.from(domains)]); } } },
  './realtime.service.js': {}, './friendSuggestion.service.js': {},
  './profile.service.js': { profileService: { load: async () => new Map() } },
  './friendOuting.views.js': { outingAccess: async () => 'full', outingRestricted: async () => false, outingInvitationEligible: async () => true, outingView: async (doc) => ({ revision: doc.revision }) },
  './friendOuting.mutations.js': { applyOutingMutation: () => ({ resultId: 'result', bucket: 'ordinary' }), outingOperationConflict: () => error('operation conflict'), outingRevisionConflict: () => error('revision conflict') },
  './friendOuting.validation.js': { outingPayloadHash: () => mismatch ? 'different' : 'hash' },
};
repo.groupHasBlock = async () => false;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
const service = mod.exports.friendOutingService;
const me = { _id: new ObjectId(actor), displayName: 'A' };
const mutation = { operationId: 'op', expectedRevision: 1 };
function reset(nextMode) { stored = base(); mode = nextMode; calls = []; mismatch = false; }
(async () => {
  reset('ok');
  const done = await service.mutate(me, 'outing', 'edit', mutation);
  assert.equal(done.outcome.replayed, false);
  assert.equal(calls[0], 'cas');
  assert.deepEqual(calls[1], ['outing', [actor, other, pending].join(','), ['friend-outings']]);
  calls = [];
  const replay = await service.mutate(me, 'outing', 'edit', mutation);
  assert.equal(replay.outcome.replayed, true);
  assert.deepEqual(calls, [], 'ordinary replay sends no new hint');
  mismatch = true;
  await assert.rejects(service.mutate(me, 'outing', 'edit', mutation), /operation conflict/);
  assert.deepEqual(calls, [], 'operation mismatch does not write');
  reset('ambiguous');
  const confirmed = await service.mutate(me, 'outing', 'edit', mutation);
  assert.equal(confirmed.outcome.replayed, true);
  assert.deepEqual(calls[1], ['outing', [actor, other, pending].join(','), ['friend-outings']], 'confirmed ambiguous commit signalled');
  reset('fail');
  await assert.rejects(service.mutate(me, 'outing', 'edit', mutation), /revision conflict/);
  assert.deepEqual(calls, ['cas']);
  reset('ok');
  await assert.rejects(service.mutate(me, 'outing', 'edit', { ...mutation, expectedRevision: 0 }), /revision conflict/);
  assert.deepEqual(calls, [], 'stale revision rejected before CAS');
  stored = null; mode = 'ambiguous'; calls = [];
  const created = await service.create(me, { operationId: 'create', inviteeIds: [pending], title: 'test', outingDate: '2026-01-01' });
  assert.equal(created.outcome.replayed, true);
  assert.equal(calls[0], 'create');
  assert.deepEqual(calls[1], ['outing', [actor, pending].join(','), ['friend-outings']]);
  calls = [];
  await service.create(me, { operationId: 'create', inviteeIds: [pending], title: 'test', outingDate: '2026-01-01' });
  assert.deepEqual(calls, [], 'create replay is not a new write');
  console.log('PASS social outing: CAS, replay, revision conflict and ambiguous create/CAS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
