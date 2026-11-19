'use strict';
// Actual cursor, repository and service; all persistence/recovery boundaries are synthetic.
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const id = n => n.toString(16).padStart(24, '0');
const cid = new Types.ObjectId(id(900)), owner = id(1), other = id(2);
const plain = x => JSON.parse(JSON.stringify(x));
const rows = Array.from({ length: 105 }, (_, n) => ({ _id: new Types.ObjectId(id(n + 10)), coupleId: cid,
  type: n % 3 === 0 ? 'exp' : 'coin', ownerUserId: n % 4 === 0 ? null : new Types.ObjectId(n % 2 ? owner : other),
  actorUserId: new Types.ObjectId(owner), createdAt: new Date('2026-11-18T00:00:00.000Z'),
  delta: 5, balanceAfter: 10, reason: 'quest', refId: null }));
rows.push({ ...rows[0], _id: new Types.ObjectId(id(500)), coupleId: new Types.ObjectId(id(901)) });
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every(f => matches(row, f));
    if (key === '$or') return value.some(f => matches(row, f));
    if (value && typeof value === 'object' && '$lt' in value) return row[key] < value.$lt;
    return row[key] == null ? value == null : String(row[key]) === String(value);
  });
}
let calls = [], limitSeen;
const LedgerEntry = { find(filter) { calls.push(filter); return {
  sort(sort) { assert.deepEqual(plain(sort), { createdAt: -1, _id: -1 }); return this; },
  limit(limit) { limitSeen = limit; return this; },
  exec: async () => rows.filter(r => matches(r, filter)).sort((a,b) => b.createdAt-a.createdAt || String(b._id).localeCompare(String(a._id))).slice(0, limitSeen),
}; } };
const base = loader({ ...quiet, 'models/LedgerEntry.ts': { LedgerEntry } });
const repoModule = base('repositories/wallet.repository.ts');
let order = [];
const service = loader({ ...quiet, 'models/Couple.ts': { Couple: mongoose.models.Couple }, 'repositories/wallet.repository.ts': { ...repoModule, walletRepository: {
  ...repoModule.walletRepository,
  getOrCreate: async () => { order.push('own'); return { memberIds: [owner, other], balances: { [owner]: 0 }, pending: null }; },
  listLedgerPage: (...args) => { order.push('read'); return repoModule.walletRepository.listLedgerPage(...args); },
} } })('services/wallet.service.ts').walletService;
service.recoverRewards = async () => { order.push('recover'); };
(async () => {
  for (const type of [undefined, 'coin', 'exp']) {
    const all = []; let cursor;
    do {
      order = [];
      const page = await service.listLedgerPage(cid, owner, { type, limit: 20, cursor });
      assert.deepEqual(order, ['own', 'recover', 'read']); assert.equal(limitSeen, 21);
      assert.ok(page.items.length <= 20); all.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    const expected = rows.filter(r => matches(r, { coupleId: cid }) && (!type || r.type === type)
      && (r.type === 'exp' || String(r.ownerUserId) === owner || r.type === 'coin' && r.ownerUserId == null));
    assert.equal(all.length, expected.length); assert.equal(new Set(all.map(r => r.id)).size, expected.length);
    assert.ok(all.every(r => type !== 'coin' || r.scope !== 'shared_exp'));
  }
  const first = await service.listLedgerPage(cid, owner, { limit: 1 });
  for (const input of [ { cursor: first.nextCursor, type: 'coin' }, { cursor: '' }, { cursor: 'a'.repeat(1025) }, { cursor: 'not-json' } ]) {
    order = []; await assert.rejects(service.listLedgerPage(cid, owner, { limit: 20, ...input }), e => e.status === 400);
    assert.deepEqual(order, []);
  }
  await assert.rejects(service.listLedgerPage(cid, other, { limit: 20, cursor: first.nextCursor }), e => e.status === 400);
  const { encodeHistoryCursor, decodeHistoryCursor } = base('utils/historyCursor.ts');
  const scope = `ledger:${cid}:${owner}:all`;
  const cursor = encodeHistoryCursor(scope, { createdAt: rows[0].createdAt, id: id(10) });
  assert.equal(decodeHistoryCursor(cursor, scope).id, id(10));
  assert.throws(() => decodeHistoryCursor(cursor + '=', scope), e => e.status === 400);
  const invalid = Buffer.from(JSON.stringify([1,scope,'desc','2026-11-18',id(10)])).toString('base64url');
  assert.throws(() => decodeHistoryCursor(invalid, scope), e => e.status === 400);
  const legacy = await repoModule.walletRepository.listLedger(cid, owner);
  assert.ok(Array.isArray(legacy)); assert.equal(limitSeen, 50);
  assert.ok(calls.some(c => c.$and?.length === 2), 'ACL and seek remain separate conjuncts');
  console.log('PASS ledger pages: actual scoped seek/visibility, timestamp ties, recovery order, canonical cursor, legacy array');
})().catch(error => { console.error(error); process.exitCode = 1; });
