'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const ids = ['000000000000000000000001', '000000000000000000000002'];
const coupleId = new Types.ObjectId();
const copy = x => JSON.parse(JSON.stringify(x));
const query = fn => ({ exec: async () => fn() });
let wallet, couple, ops, ledger, fault, walletReads, applyHook, expHook;
const crash = step => { if (fault === step) { fault = null; throw Error(`fault:${step}`); } };
function reset() {
  wallet = { coupleId, version: 2, memberIds: ids, balances: { [ids[0]]: 10, [ids[1]]: 10 }, revision: 0, pending: null };
  couple = { _id: coupleId, memberIds: ids.map(x => new Types.ObjectId(x)), exp: 0, level: 1, expRevision: 0, expReceipt: null };
  ops = new Map(); ledger = new Map(); fault = null; walletReads = 0; applyHook = null; expHook = null;
}
const Couple = {
  findById: () => query(() => ({ ...couple, expReceipt: couple.expReceipt && copy(couple.expReceipt) })),
  findOneAndUpdate: (filter, update) => query(async () => {
    if (expHook) { const hook = expHook; expHook = null; await hook(); }
    if (couple.expReceipt || couple.expRevision !== filter.$expr.$eq[1]) return null;
    couple.exp += update.$inc.exp; couple.expRevision++; Object.assign(couple, update.$set);
    crash('exp'); return copy(couple);
  }),
  updateOne: (filter, update) => query(() => {
    if (couple.expReceipt?.operationId === filter['expReceipt.operationId']) { couple.expReceipt = null; couple.expRevision++; }
    crash('exp-clear');
  }),
};
const repo = {
  getOrCreate: async () => { walletReads++; return copy(wallet); },
  readSettled: async () => { assert.equal(wallet.pending, null); return { wallet: copy(wallet), couple: { ...couple } }; },
  findOperation: async id => ops.has(id) ? copy(ops.get(id)) : null,
  ensureOperation: async (id, cid, payload, fingerprint) => {
    if (!ops.has(id)) ops.set(id, { _id: id, coupleId: String(cid), payload: copy(payload), fingerprint, status: 'pending', result: null });
    return copy(ops.get(id));
  },
  apply: async (_cid, revision, balances, pending) => {
    if (applyHook) { const hook = applyHook; applyHook = null; await hook(); }
    if (wallet.revision !== revision || wallet.pending) return null;
    wallet.balances = copy(balances); wallet.pending = copy(pending); wallet.revision++; crash('balance'); return copy(wallet);
  },
  appendLedger: async input => { if (!ledger.has(input.operationKey)) ledger.set(input.operationKey, copy(input)); crash(input.type === 'exp' ? 'exp-ledger' : 'ledger'); },
  commit: async (id, result, rejected) => { const op = ops.get(id); if (op.status === 'pending') Object.assign(op, { result: copy(result), status: rejected ? 'rejected' : 'committed' }); crash('commit'); },
  clear: async (_cid, pending) => { if (wallet.pending?.operationId === pending.operationId && wallet.pending.revision === pending.revision) { wallet.pending = null; wallet.revision++; } crash('clear'); },
  listLedger: async (_cid, owner, type) => [...ledger.values()].filter(e => (!type || e.type === type) && (e.type === 'exp' || !e.ownerUserId || e.ownerUserId === owner)).map(e => ({ ...e, _id: new Types.ObjectId(), actorUserId: new Types.ObjectId(e.actorUserId), ownerUserId: e.ownerUserId ? new Types.ObjectId(e.ownerUserId) : null, createdAt: new Date() })),
};
const load = loader({ ...quiet, 'models/Couple.ts': { Couple } });
const { splitCoin, walletReview } = load('repositories/wallet.repository.ts');
const emptySource = { find: () => ({ sort: () => ({ limit: () => query(() => []) }) }) };
const service = loader({ ...quiet, 'models/Couple.ts': { Couple }, 'models/Checkin.ts': { Checkin: emptySource },
  'models/Quest.ts': { QuestProgress: emptySource }, 'models/BucketItem.ts': { BucketItem: emptySource },
  'repositories/bucket.repository.ts': {}, 'repositories/wallet.repository.ts': { walletRepository: repo, splitCoin, walletReview } })('services/wallet.service.ts').walletService;
const reward = (operationId = 'reward', extra = {}) => service.reward({ coupleId, operationId, actorUserId: ids[1], coin: 5, exp: 9, reason: 'quest', ...extra });
const coin = (operationId, delta, ownerUserId = ids[0]) => service.applyCoin({ coupleId, operationId, actorUserId: ids[0], ownerUserId, delta, reason: 'admin' });
(async () => {
  assert.deepEqual(copy(splitCoin(0, [...ids].reverse())), { [ids[0]]: 0, [ids[1]]: 0 });
  assert.deepEqual(copy(splitCoin(4, ids)), { [ids[0]]: 2, [ids[1]]: 2 });
  assert.deepEqual(copy(splitCoin(5, [...ids].reverse())), { [ids[0]]: 3, [ids[1]]: 2 });
  for (const invalid of [-1, 1.1, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => splitCoin(invalid, ids));
  assert.throws(() => splitCoin(2, [ids[0], ids[0]]));
  for (const step of ['balance', 'exp', 'ledger', 'exp-ledger', 'commit', 'exp-clear', 'clear']) {
    reset(); fault = step;
    await assert.rejects(reward(), new RegExp(`fault:${step}`));
    await reward(); await service.getView(coupleId, ids[0]);
    assert.deepEqual(wallet.balances, { [ids[0]]: 13, [ids[1]]: 12 }, step);
    assert.equal(couple.exp, 9, step); assert.equal(ledger.size, 3, step);
    assert.equal(wallet.pending, null); assert.equal(couple.expReceipt, null);
    const reads = walletReads; await reward(); assert.equal(walletReads, reads, 'terminal checked before wallet snapshot');
  }
  reset(); await Promise.all([reward(), reward(), reward()]); assert.equal(couple.exp, 9); assert.equal(ledger.size, 3);
  await assert.rejects(reward('reward', { coin: 6 }), e => e.status === 409);
  reset(); await assert.rejects(coin('spend', -15), e => e.status === 422); assert.equal(wallet.balances[ids[0]], 10);
  await coin('topup', 10); await assert.rejects(coin('spend', -15), e => e.status === 422); assert.equal(wallet.balances[ids[0]], 20, 'rejected op never becomes spendable');
  reset(); await reward('individual', { ownerUserId: ids[1] }); assert.equal(wallet.balances[ids[0]], 10); assert.equal(wallet.balances[ids[1]], 15);
  await assert.rejects(service.getView(coupleId, new Types.ObjectId().toString()), e => e.status === 403);
  const rows = await service.listLedger(coupleId, ids[0]); assert.equal(rows.filter(e => e.type === 'coin').length, 0);
  // Worker A pauses immediately before CAS; B applies, commits, clears. Old revision MUST fail.
  reset(); applyHook = async () => { await reward(); }; await reward(); assert.equal(couple.exp, 9); assert.equal(wallet.balances[ids[0]], 13);
  // Same stale-worker schedule immediately before EXP CAS, after B has cleared Couple receipt.
  reset(); expHook = async () => { await reward(); }; await reward(); assert.equal(couple.exp, 9); assert.equal(ledger.size, 3);
  reset(); await reward('legacy-fingerprint');
  const legacyPayload = { actorUserId: ids[1], allocations: { [ids[0]]: 3, [ids[1]]: 2 }, exp: 9, reason: 'quest', refId: null };
  assert.deepEqual(ops.get(`${coupleId}:legacy-fingerprint`).payload, legacyPayload);
  assert.equal(ops.get(`${coupleId}:legacy-fingerprint`).fingerprint, require('node:crypto').createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex'));
  assert.ok([...ledger.values()].every(row => !Object.hasOwn(row,'provenance')), 'legacy ledger has no inferred metadata');
  const provenance = {version:1,source:'moment',localDate:'2026-01-01',policyVersion:2,component:'photo_base',baseCoin:10,bonusCoin:0};
  await reward('new-provenance',{coin:10,exp:0,reason:'moment',ownerUserId:ids[0],allocations:{[ids[0]]:10},provenance});
  assert.deepEqual(ops.get(`${coupleId}:new-provenance`).payload.provenance,provenance);
  assert.deepEqual((await service.listLedger(coupleId,ids[0])).find(row=>row.reason==='moment').provenance,provenance);
  await assert.rejects(reward('new-provenance',{coin:10,exp:0,reason:'moment',ownerUserId:ids[0],allocations:{[ids[0]]:10},provenance:{...provenance,bonusCoin:1}}),e=>e.status===409);
  console.log('PASS personal wallet service: split, ownership, durable faults, concurrent replay, terminal lookup, wallet/EXP fencing, exact legacy fingerprints and immutable provenance');
})().catch(error => { console.error(error); process.exitCode = 1; });
