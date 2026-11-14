/* Supplemental AFTER-ONLY service/DB benchmark, NOT HTTP or a before/after comparison.
 * tsx scripts/measure-outing-detail.ts --check                 (no sockets/DB)
 * tsx scripts/measure-outing-detail.ts --exclusive-local-fixture
 * Requires exclusive local MongoDB 127.0.0.1:27017. Creates a random, fresh,
 * retained synthetic database. Never reads .env, existing records, or deletes data.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { FriendOutingRecord } from '../src/models/FriendOuting.js';

type Counts = Record<string, number>;
type Sample = { ms: number; bytes: number; queries: Counts };
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function main() {
  assert.equal(process.argv.length, 3, 'Use --check or --exclusive-local-fixture only');
  const mode = process.argv[2];
  assert(['--check', '--exclusive-local-fixture'].includes(mode), 'Explicit fixture flag required');
  const require = createRequire(__filename);
  require('dotenv').config = () => ({ parsed: {} });
  const tag = randomBytes(8).toString('hex');
  const dbName = `outing_detail_exclusive_fixture_${tag}`;
  process.env = {
    NODE_ENV: 'test', MONGODB_URI: `mongodb://127.0.0.1:27017/${dbName}`,
    JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    AI_PROVIDER: 'mock', AI_CHAT_PROVIDER: 'mock', BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock',
    STORAGE_PROVIDER: 'memory', SCHEDULER_ENABLED: 'false',
  };
  const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: any[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof normalized[0] === 'object' ? normalized[0] : { port: normalized[0], host: normalized[1] };
    if (mode === '--check' || !options || options.path || options.host !== '127.0.0.1' || Number(options.port) !== 27017) {
      throw new Error('Fixture refuses this socket; fixed loopback MongoDB only');
    }
    return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
  } as typeof originalConnect;
  require('node:tls').connect = () => { throw new Error('Fixture refuses TLS'); };
  globalThis.fetch = async () => { throw new Error('Fixture refuses fetch'); };

  const mongoose = require('mongoose') as typeof import('mongoose');
  const { Types, mongo } = mongoose;
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  mongoose.set('bufferCommands', false);
  mongoose.set('maxTimeMS', 3000);
  const { User } = await import('../src/models/User.js');
  const { Friendship } = await import('../src/models/Friendship.js');
  const { FriendBlock } = await import('../src/models/FriendSafety.js');
  const { FriendOuting } = await import('../src/models/FriendOuting.js');
  const { assertOutingCapacity } = await import('../src/repositories/friendOuting.repository.js');
  const { equalAllocations, outingBalances } = await import('../src/services/friendExpenseMath.js');
  const { friendOutingService } = await import('../src/services/friendOuting.service.js');
  const now = new Date('2026-11-13T12:00:00.000Z');
  const users = Array.from({ length: 50 }, (_, i) => new User({
    email: `fixture-${tag}-${i}@example.invalid`, passwordHash: 'synthetic-unused-no-login',
    displayName: `Synthetic member ${i}`, friendsJoinedAt: now,
  }));
  const ids = users.map(u => u._id.toString()).sort();
  const me = users.find(u => u._id.toString() === ids[0])!;
  function fixture(memberCount: number, expenseCount: number, receiptCount: number): FriendOutingRecord {
    const members = ids.slice(0, memberCount), _id = new Types.ObjectId();
    const expenses: FriendOutingRecord['expenses'] = Array.from({ length: expenseCount }, (_, i) => ({
      id: new Types.ObjectId().toString(), payerId: ids[0], title: '界'.repeat(160), amount: 100_000_000,
      participantIds: [...members], splitMode: 'equal', allocations: equalAllocations(100_000_000, members),
      status: expenseCount === 200 && i < 100 ? 'void' : 'active', createdAt: now, updatedAt: now,
    }));
    return { _id, schemaVersion: 1, creatorId: ids[0], createOperationId: `fixture-${_id}`, createHash: 'f'.repeat(64),
      eventId: null, title: '界'.repeat(100), outingDate: '2026-11-13',
      participants: members.map(userId => ({ userId, displayName: '界'.repeat(100), status: 'accepted', consent: null })),
      expenses, settlements: [], receipts: Array.from({ length: receiptCount }, (_, i) => ({
        operationId: i.toString().padStart(80, '0'), actorId: ids[0], kind: 'expense_edit', hash: 'f'.repeat(64),
        resultId: expenses[0].id, revision: i + 1, financeRevision: 1, at: now, bucket: 'ordinary',
      })), phase: 'collecting', revision: receiptCount, financeRevision: 1, ordinaryOperations: receiptCount,
      reservedOperations: 0, editCount: expenseCount === 200 ? 1000 : 0,
      totalExpenses: expenses.filter(e => e.status === 'active').reduce((sum, e) => sum + e.amount, 0),
      frozenAt: null, completedAt: null, createdAt: now, updatedAt: now };
  }
  const fixtures = [fixture(2, 20, 100), fixture(50, 200, 3000)];
  for (const doc of fixtures) {
    assert.ifError(new FriendOuting(doc).validateSync());
    assertOutingCapacity(doc, true);
    assert.equal(outingBalances(doc.participants.map(p => p.userId), doc.expenses, []).reduce((s, b) => s + b.balance, 0), 0);
  }
  for (const u of users) assert.ifError(u.validateSync());
  if (mode === '--check') {
    console.log('PASS pure schema/capacity/math checks: 2 members/20 expenses/100 receipts and 50 members/200 expenses/3000 receipts; no DB or sockets');
    return;
  }

  const deadline = setTimeout(() => { console.error('FAIL fixture exceeded 120 seconds'); process.exit(1); }, 120_000);
  try {
    await mongoose.connect(process.env.MONGODB_URI!, {
      serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
      waitQueueTimeoutMS: 5000, maxPoolSize: 8, autoCreate: false, autoIndex: false,
    });
    const db = mongoose.connection.db!;
    assert.equal(db.databaseName, dbName);
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'Refuses non-fresh database');
    // Only these newly created collections/indexes are touched, never production indexes.
    for (const model of [User, Friendship, FriendBlock, FriendOuting]) {
      await model.createCollection();
      await model.createIndexes();
    }
    await User.insertMany(users);
    await Friendship.insertMany(ids.slice(1).map(peer => ({ requesterId: ids[0], recipientId: peer,
      pairKey: `${ids[0]}:${peer}`, status: 'accepted', acceptedAt: now })));
    await FriendOuting.insertMany(fixtures);
    const context = new AsyncLocalStorage<Counts>();
    mongoose.set('debug', (collection: string, method: string) => {
      const counts = context.getStore();
      if (!counts) return;
      assert(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct'].includes(method), 'Measured detail must be read-only');
      const key = `${collection}.${method}`;
      counts[key] = (counts[key] ?? 0) + 1;
    });
    const digest = (value: object) => createHash('sha256').update(mongo.BSON.serialize(value)).digest('hex');
    for (const doc of fixtures) {
      const before = await FriendOuting.findById(doc._id).lean().maxTimeMS(3000).exec();
      assert(before);
      const sample = async (): Promise<Sample> => context.run({}, async () => {
        const started = performance.now();
        const dto = await friendOutingService.get(me, doc._id.toString());
        const ms = performance.now() - started; // service promise only; JSON serialization excluded
        assert.equal(dto.access, 'full');
        assert('expenses' in dto && dto.expenses.length === doc.expenses.length);
        return { ms, bytes: Buffer.byteLength(JSON.stringify(dto), 'utf8'), queries: { ...context.getStore()! } };
      });
      await sample(); // one unreported warm-up per fixture
      const sequential: Sample[] = [];
      for (let i = 0; i < 12; i++) sequential.push(await sample());
      const concurrent: Sample[] = [];
      for (let wave = 0; wave < 3; wave++) concurrent.push(...await Promise.all(Array.from({ length: 4 }, sample)));
      for (const [label, samples] of [['sequential', sequential], ['concurrency4x3', concurrent]] as const) {
        const totals: Counts = {};
        for (const s of samples) for (const [key, n] of Object.entries(s.queries)) totals[key] = (totals[key] ?? 0) + n;
        console.log(JSON.stringify({ scope: 'after-only service+DB; not HTTP', members: doc.participants.length,
          expenses: doc.expenses.length, active: doc.expenses.filter(e => e.status === 'active').length,
          receipts: doc.receipts.length, mode: label, samples: samples.length,
          p50Ms: percentile(samples.map(s => s.ms), .5), p95Ms: percentile(samples.map(s => s.ms), .95),
          dtoJsonBytes: [...new Set(samples.map(s => s.bytes))], aggregateDebugCounts: totals,
          perCallDebugCounts: samples.map(s => s.queries) }));
      }
      const explained = await FriendOuting.collection.find({ _id: doc._id }).limit(1).maxTimeMS(3000).explain('executionStats');
      const stats = explained.executionStats;
      assert.equal(stats.nReturned, 1);
      assert.equal(stats.totalDocsExamined, 1);
      console.log(JSON.stringify({ scope: 'direct detail _id explain only; excludes ACL queries', members: doc.participants.length,
        keysExamined: stats.totalKeysExamined, docsExamined: stats.totalDocsExamined,
        nReturned: stats.nReturned, winningPlan: explained.queryPlanner.winningPlan }));
      const after = await FriendOuting.findById(doc._id).lean().maxTimeMS(3000).exec();
      assert(after);
      assert.equal(digest(after), digest(before), 'Detail must not mutate the retained outing');
    }
    console.log(`PASS retained fresh synthetic database ${dbName}; 50 users, 49 accepted creator friendships, 2 outings; no couple required`);
    console.log('LIMIT service/DB only, no HTTP/auth/middleware/transport, no before baseline, no crash/journal or production evidence; nearest-rank p95 from 12 samples is the maximum');
  } finally {
    mongoose.set('debug', false);
    await mongoose.disconnect();
    clearTimeout(deadline);
  }
}
main().catch((error: unknown) => {
  if (process.argv[2] === '--check') console.error(error);
  else console.error('FAIL outing detail fixture (details suppressed; no secrets logged)');
  process.exitCode = 1;
});
