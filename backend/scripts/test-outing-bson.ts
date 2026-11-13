/* Pure, synthetic BSON capacity envelope; no database or service bootstrapping.
 * Run with the backend's installed tsx and dependencies.
 * This is an upper envelope of bounded field sizes, not a replay proving all maxima
 * are simultaneously reachable: receipts and settlement history are synthesized.
 */
import assert from 'node:assert/strict';
import { Types, mongo } from 'mongoose';
import { FriendOuting, OUTING_LIMITS, type FriendOutingRecord } from '../src/models/FriendOuting.js';
import { assertOutingCapacity, outingBsonBytes } from '../src/repositories/friendOuting.repository.js';
import { customAllocations, equalAllocations, outingBalances } from '../src/services/friendExpenseMath.js';
import { outingPayloadHash, outingSchemas } from '../src/services/friendOuting.validation.js';

const id = (n: number) => n.toString(16).padStart(24, '0');
const ids = Array.from({ length: 50 }, (_, i) => id(i + 1));
const date = new Date('2026-11-13T12:00:00.000Z');
const operationId = 'x'.repeat(80);
const title = '界'.repeat(100);
const expenseTitle = '界'.repeat(160);
const shares = ids.map(userId => ({ userId, amount: 2_000_000 }));
const group = (name: string, run: () => void) => { run(); console.log(`PASS ${name}`); };

group('DTO create and equal expense canonicalization', () => {
  const create = outingSchemas.create.parse({ operationId, expectedRevision: 0, title, outingDate: '2026-11-13', inviteeIds: ids.slice(1).reverse(), eventId: id(100) });
  assert.deepEqual(create.inviteeIds, ids.slice(1));
  assert.equal(outingSchemas.create.safeParse({ ...create, outingDate: '2026-02-30' }).success, false);
  const expense = outingSchemas.expense.parse({ operationId, expectedRevision: 1, title: expenseTitle, amount: OUTING_LIMITS.expenseAmount, splitMode: 'equal', participantIds: [...ids].reverse() });
  assert.deepEqual(expense.participantIds, ids);
  assert.deepEqual(equalAllocations(expense.amount, expense.participantIds!), shares);
});

group('DTO custom all-positive split and canonical hash', () => {
  const input = outingSchemas.expense.parse({ operationId, expectedRevision: 1, title: expenseTitle, amount: OUTING_LIMITS.expenseAmount, splitMode: 'custom', allocations: [...shares].reverse() });
  assert.deepEqual(customAllocations(input.amount, input.allocations!), shares);
  assert.equal(outingPayloadHash('expense_create', input), outingPayloadHash('expense_create', { ...input, allocations: shares, expectedRevision: 2 }));
  assert.throws(() => customAllocations(input.amount - 1, input.allocations!));
});

const doc: FriendOutingRecord = {
  _id: new Types.ObjectId(id(1000)), schemaVersion: 1, creatorId: ids[0], createOperationId: operationId,
  createHash: 'f'.repeat(64), eventId: new Types.ObjectId(id(1001)), title, outingDate: '2026-11-13',
  participants: ids.map(userId => ({ userId, displayName: title, status: 'accepted', consent: { status: 'approved', financeRevision: 1000 } })),
  expenses: Array.from({ length: 200 }, (_, i) => ({ id: id(2000 + i), payerId: ids[0], title: expenseTitle,
    amount: OUTING_LIMITS.expenseAmount, participantIds: [...ids], splitMode: 'custom', allocations: shares.map(s => ({ ...s })),
    status: i < 100 ? 'void' : 'active', createdAt: date, updatedAt: date })),
  settlements: [], receipts: [], phase: 'settling', revision: 3000, financeRevision: 1000,
  ordinaryOperations: 3000, reservedOperations: 0, editCount: 1000, ordinaryWritesClosed: true,
  totalExpenses: OUTING_LIMITS.totalExpenses, frozenAt: date, completedAt: null, createdAt: date, updatedAt: date,
};
const receipt = (i: number, bucket: 'ordinary' | 'reserved') => ({
  operationId: i.toString().padStart(80, '0'), actorId: ids[0], kind: 'k'.repeat(40), hash: 'f'.repeat(64),
  resultId: id(2000), revision: i + 1, financeRevision: 1000, at: date, bucket,
});
doc.receipts = Array.from({ length: 3000 }, (_, i) => receipt(i, 'ordinary'));

group('expense and financial invariants', () => {
  assert.equal(doc.participants.length, 50);
  assert.equal(doc.expenses.length, 200);
  assert.equal(doc.expenses.filter(e => e.status === 'void').length, 100);
  assert.equal(doc.expenses.filter(e => e.status === 'active').reduce((sum, e) => sum + e.amount, 0), 10_000_000_000);
  for (const e of doc.expenses) {
    assert.deepEqual(e.participantIds, ids);
    assert.deepEqual(e.allocations, shares);
    assert.equal(e.allocations.reduce((sum, a) => sum + a.amount, 0), e.amount);
  }
  const balances = outingBalances(ids, doc.expenses, []);
  assert.equal(balances.reduce((sum, b) => sum + b.balance, 0), 0);
  assert.equal(balances.find(b => b.userId === ids[0])!.balance, 9_800_000_000);
});

const ordinary = outingBsonBytes(doc);
group('ordinary checkpoint actual BSON and capacity', () => {
  assert.equal(ordinary, mongo.BSON.calculateObjectSize(doc));
  assertOutingCapacity(doc, true);
  assert(ordinary < OUTING_LIMITS.ordinaryBytes);
});

// Terminal rejected transfers preserve balances; amounts are valid debt and credit.
// Sizes deliberately use the schema's 40-character receipt kind, not just real
// operation names; a maximal receipt mix is not asserted reachable by transitions.
doc.settlements = Array.from({ length: 500 }, (_, i) => ({ id: id(3000 + i), fromUserId: ids[1], toUserId: ids[0],
  amount: 200_000_000, status: 'rejected', createdAt: date, resolvedAt: date }));
doc.receipts.push(...Array.from({ length: 1052 }, (_, i) => receipt(3000 + i, 'reserved')));
doc.reservedOperations = 1052;
doc.revision = 4052;
const maximum = outingBsonBytes(doc);
group('bounded terminal envelope, schema, BSON and reserve', () => {
  assert.equal(doc.receipts.length, 4052);
  assert.equal(doc.settlements.length, 500);
  assert.equal(doc.editCount, 1000);
  assert.equal(doc.receipts.filter(r => r.bucket === 'ordinary').length, 3000);
  assert.equal(doc.receipts.filter(r => r.bucket === 'reserved').length, 1052);
  assert.equal(outingBalances(ids, doc.expenses, doc.settlements).reduce((sum, b) => sum + b.balance, 0), 0);
  const validation = new FriendOuting(doc).validateSync();
  assert.ifError(validation);
  assertOutingCapacity(doc, false);
  assert(maximum < OUTING_LIMITS.maximumBytes);
  assert(maximum - ordinary < OUTING_LIMITS.maximumBytes - OUTING_LIMITS.ordinaryBytes);
  console.log(`INFO ordinary=${ordinary} ordinaryLimit=${OUTING_LIMITS.ordinaryBytes} envelope=${maximum} maximumLimit=${OUTING_LIMITS.maximumBytes} reservedGrowth=${maximum - ordinary} reserve=${OUTING_LIMITS.maximumBytes - OUTING_LIMITS.ordinaryBytes}`);
  console.log('INFO counts members=50 expenses=200 active=100 void=100 allocationsPerExpense=50 beneficiaryIdsPerExpense=50 settlements=500 edits=1000 receipts=4052 ordinary=3000 reserved=1052');
  console.log('INFO bounded synthetic envelope only; not a simultaneously reachable operation history or a crash/journaling test');
});
