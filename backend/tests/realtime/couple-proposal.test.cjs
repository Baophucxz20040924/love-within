const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./couple-test-loader.cjs');

class Id { value ; constructor(value ) { this.value = value; } toString() { return this.value; } }
const state = { Id, events: [] , doc: null , effect: false, applied: 0, failApply: false, locked: false };
(globalThis ).__proposalTest = state;
const stubs = {
  mongoose: `export const Types = { ObjectId: globalThis.__proposalTest.Id };`,
  './realtimeAudience.service.js': `export const realtimeAudience = { couple: async (...args) => { if (globalThis.__proposalTest.locked) throw Error('under lock'); globalThis.__proposalTest.events.push(args); } };`,
  '../repositories/proposal.repository.js': `export const proposalRepository = {
 findById: async () => globalThis.__proposalTest.doc,
 findPendingByKind: async () => null,
 create: async input => { const s = globalThis.__proposalTest; return s.doc = { ...input, _id: new s.Id('p1'), approvals: [input.createdBy], status: 'pending', createdAt: new Date('2026-01-01'), resolvedAt: null }; },
 addApproval: async (cid, id, uid) => { const p = globalThis.__proposalTest.doc; if (!p.approvals.some(x => String(x) === String(uid))) p.approvals.push(uid); return p; },
 resolve: async (cid, id, status) => { const p = globalThis.__proposalTest.doc; p.status = status; p.resolvedAt = new Date(); return p; },
  };`,
  '../utils/errors.js': `export class AppError extends Error { constructor(status, code, msg) { super(msg); this.status=status; this.code=code; } } const err = m => new AppError(409, 'CONFLICT', m); export const Errors = { badRequest: err, conflict: err, notFound: err };`,
  './savingsWrite.service.js': `export const withSavingsWrite = async (couple, uid, work) => { const s=globalThis.__proposalTest; s.locked=true; const ctx={ couple, dirty:new Set(), afterRelease:[] }; let result; try { result=await work(ctx); } finally { s.locked=false; if(ctx.dirty.size) s.events.push([couple._id, [...ctx.dirty]]); } return result; };`,
  './savings.service.js': `export const prepareSavingsProposal = async (couple, kind, payload) => payload; export const savingsEffectExists = async () => globalThis.__proposalTest.effect;`,
  '../utils/logger.js': `export const logger = { info() {} };`,
  './notification.service.js': `export const notificationService = { toPartner: async () => {} };`,
};
const { proposalService, registerProposalHandler } = loadService('proposal.service.ts', stubs);
const couple = { _id: 'couple-1', memberIds: [new Id('alice'), new Id('bob')] } ;
const handler = (kind ) => ({ kind, schema: { parse: (x ) => x }, apply: async (_couple , _payload , context ) => {
  state.applied++; if (state.failApply) throw new Error('apply failed');
  if (context.savingsWrite) context.savingsWrite.dirty.add('savings');
} });
registerProposalHandler(handler('water_goal') );
registerProposalHandler(handler('savings_goal') );
function reset() { state.events.length = 0; state.doc = null; state.effect = false; state.applied = 0; state.failApply = false; state.locked = false; }

test('proposal create and final approval signal couple independently of push', async () => {
  reset();
  await proposalService.create(couple, 'alice', 'water_goal', { goalMl: 2000 });
  assert.deepEqual(state.events, [['couple-1', ['proposals']]]);
  state.events.length = 0;
  const approved = await proposalService.approve(couple, 'bob', 'p1');
  assert.equal(approved.status, 'approved'); assert.equal(state.applied, 1);
  assert.ok(state.events.length >= 1 && state.events.every(e => e[0] === 'couple-1' && (e[1] ).includes('proposals')));
});

test('persisted proposal resolution signals even when application fails', async () => {
  reset(); await proposalService.create(couple, 'alice', 'water_goal', {}); state.events.length = 0; state.failApply = true;
  await assert.rejects(proposalService.approve(couple, 'bob', 'p1'), /apply failed/);
  assert.equal(state.doc.status, 'approved'); assert.ok(state.events.length > 0);
});

test('savings approval publishes proposals and confirmed savings after release; approved replay emits nothing', async () => {
  reset(); await proposalService.create(couple, 'alice', 'savings_goal', {}); state.events.length = 0;
  const approved = await proposalService.approve(couple, 'bob', 'p1');
  assert.equal(approved.status, 'approved'); assert.deepEqual(state.events, [['couple-1', ['proposals', 'savings']]]);
  state.events.length = 0; await proposalService.approve(couple, 'bob', 'p1');
  assert.deepEqual(state.events, []); assert.equal(state.applied, 1);
});
