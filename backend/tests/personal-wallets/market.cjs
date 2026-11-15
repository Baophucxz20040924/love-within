'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const a = new Types.ObjectId(), b = new Types.ObjectId(), couple = { _id: new Types.ObjectId(), memberIds: [a,b] };
const item = { _id: new Types.ObjectId(), coupleId: couple._id, createdBy: b, title: 'Fixture', emoji: 'x', priceCoin: 3, status: 'available' };
let rows, operations, balances, failure, debitHadReservation;
const clone = r => r && { ...r, refundIntent: r.refundIntent && { ...r.refundIntent } };
function reset() { rows = new Map(); operations = new Set(); balances = { [a]: 10, [b]: 20 }; failure = null; debitHadReservation = false; }
const repo = {
  assertReservationIndexes: async () => {}, findItem: async () => item,
  findRequest: async (_c, buyer, key) => clone([...rows.values()].find(r => String(r.buyerUserId) === String(buyer) && r.requestKey === key)),
  findOpenRequest: async () => clone([...rows.values()].find(r => ['reserving','requested','accepted','refunding'].includes(r.status))),
  createRedemption: async input => {
    if ([...rows.values()].some(r => r.requestKey === input.requestKey || ['reserving','requested','accepted','refunding'].includes(r.status))) throw Object.assign(Error('duplicate'), {code:11000});
    const row = { ...input, status: 'reserving', createdAt: new Date(), responseNote: null, respondedAt: null, fulfilledAt: null, refundIntent: null };
    rows.set(String(input._id), row); return clone(row);
  },
  findRedemption: async (_c, id) => clone(rows.get(String(id))),
  transition: async (_c, id, from, to, patch = {}) => {
    const row = rows.get(String(id)); if (row.status !== from) return null;
    Object.assign(row, { status: to }, patch);
    if (failure === `transition:${to}`) { failure = null; throw Error('transition fault'); }
    return clone(row);
  },
  listRedemptions: async () => [...rows.values()].map(clone), listByStatus: async (_c, status) => [...rows.values()].filter(r => r.status === status).map(clone),
};
const walletService = {
  applyCoin: async input => {
    if (input.delta < 0) debitHadReservation = [...rows.values()].some(r => input.operationId === `market:${r._id}:debit`);
    if (!operations.has(input.operationId)) { operations.add(input.operationId); balances[input.ownerUserId] += input.delta; }
    if (failure === (input.delta < 0 ? 'debit' : 'refund')) { failure = null; throw Error('wallet fault'); }
    return {balance: balances[input.ownerUserId]};
  },
  getView: async (_c, owner) => ({ coinBalance: balances[owner] }),
};
const service = loader({ ...quiet, 'repositories/market.repository.ts': { marketRepository: repo }, 'services/wallet.service.ts': { walletService } })('services/market.service.ts').marketService;
const request = key => service.request(couple, String(a), String(item._id), key ?? 'request-key-00000001');
(async () => {
  reset(); const both = await Promise.all([request(), request()]); assert.equal(both[0].redemption.id, both[1].redemption.id); assert.equal(rows.size, 1); assert.equal(balances[a], 7); assert.ok(debitHadReservation);
  await assert.rejects(service.request(couple, String(a), String(new Types.ObjectId()), 'request-key-00000001'), e => e.status === 409);
  // Deterministically pause A after its request-key miss. B reserves before A checks the open-request index.
  const findRequest = repo.findRequest;
  for (const sameKey of [true, false]) {
    reset();
    let resume, reached;
    const blocked = new Promise(resolve => { resume = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    let firstLookup = true;
    repo.findRequest = async (...args) => {
      const result = await findRequest(...args);
      if (firstLookup) { firstLookup = false; assert.equal(result, undefined); reached(); await blocked; }
      return result;
    };
    const delayed = request('request-key-delayed-0001');
    // Attach rejection observation before resuming the delayed continuation.
    const observed = delayed.then(value => ({ value }), error => ({ error }));
    try {
      await entered;
      const winner = await request(sameKey ? 'request-key-delayed-0001' : 'request-key-different-01');
      resume();
      const outcome = await observed;
      if (sameKey) {
        assert.ifError(outcome.error); assert.equal(outcome.value.redemption.id, winner.redemption.id);
      } else assert.equal(outcome.error?.status, 409, 'different key still conflicts with open reservation');
      assert.equal(rows.size, 1); assert.equal(operations.size, 1); assert.equal(balances[a], 7); assert.equal(balances[b], 20);
    } finally { resume(); repo.findRequest = findRequest; }
  }
  for (const step of ['debit','transition:requested']) { reset(); failure = step; await assert.rejects(request()); await request(); assert.equal(balances[a], 7); assert.equal(rows.size, 1); }
  for (const step of ['refund','transition:refunding','transition:declined']) {
    reset(); const r = await request(); failure = step; await assert.rejects(service.decline(couple, String(b), r.redemption.id, null));
    await service.decline(couple, String(b), r.redemption.id, null); assert.equal(balances[a], 10); assert.equal(balances[b], 20);
  }
  reset(); const r = await request();
  const race = await Promise.allSettled([service.cancel(couple, String(a), r.redemption.id), service.decline(couple, String(b), r.redemption.id, null)]);
  assert.equal(race.filter(x => x.status === 'fulfilled').length, 1); assert.equal(balances[a], 10); assert.equal(balances[b], 20); assert.equal(operations.size, 2);
  reset(); const legacyId = new Types.ObjectId(); rows.set(String(legacyId), { _id: legacyId, itemId: item._id, buyerUserId: a, sellerUserId: b, priceCoin: 7, status: 'declined', createdAt: new Date() });
  await service.decline(couple, String(b), String(legacyId), null); assert.equal(operations.size, 0, 'historical terminal without durable intent never refunds');
  rows.get(String(legacyId)).status = 'requested'; await service.decline(couple, String(b), String(legacyId), null); assert.equal(balances[a], 17); assert.equal(balances[b], 20);
  console.log('PASS market: reservation before debit, duplicate keys, debit/refund faults, cancel-decline CAS, buyer-only legacy refund');
})().catch(e => { console.error(e); process.exitCode = 1; });
