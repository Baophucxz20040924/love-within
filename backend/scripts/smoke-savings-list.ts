import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';

// Offline fixture only. App configuration receives synthetic process-only values;
// dotenv is disabled before any app imports, so the real .env is never loaded.
// The operator must ensure this fixed loopback database is fresh and exclusively owned.
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--exclusive-local-fixture') {
    throw new Error('Requires --exclusive-local-fixture and an exclusively owned fresh local MongoDB fixture');
  }
  const require = createRequire(__filename);
  require('dotenv').config = () => ({ parsed: {} });
  const uri = 'mongodb://127.0.0.1:27017/savings_list_exclusive_fixture';
  process.env = {
    NODE_ENV: 'test', MONGODB_URI: uri,
    JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    AI_PROVIDER: 'mock', AI_CHAT_PROVIDER: 'mock', BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock',
    STORAGE_PROVIDER: 'memory', SCHEDULER_ENABLED: 'false',
  };
  const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: any[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof normalized[0] === 'object' ? normalized[0] : { port: normalized[0], host: normalized[1] };
    if (!options || options.path || options.host !== '127.0.0.1' || Number(options.port) !== 27017) {
      throw new Error('Fixture refuses sockets other than the fixed loopback MongoDB endpoint');
    }
    return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
  } as typeof originalConnect;
  // MongoDB here uses no TLS; reject TLS and fetch outright, including accidental provider calls.
  require('node:tls').connect = () => { throw new Error('Fixture refuses TLS sockets'); };
  globalThis.fetch = async () => { throw new Error('Fixture refuses fetch'); };
  const mongoose = (await import('mongoose')).default;
  const { Types } = mongoose;
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  const { Couple } = await import('../src/models/Couple.js');
  const { SavingsGoal } = await import('../src/models/SavingsGoal.js');
  const { SavingsEntry } = await import('../src/models/SavingsEntry.js');
  const { savingsService } = await import('../src/services/savings.service.js');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000, autoCreate: false, autoIndex: false });
  try {
    const db = mongoose.connection.db!;
    if ((await db.listCollections({}, { nameOnly: true }).toArray()).length) {
      throw new Error('Fixture database is not fresh; refusing to modify it');
    }
    for (const model of [Couple, SavingsGoal, SavingsEntry]) {
      await model.createCollection();
      await model.syncIndexes();
    }
    const members = [new Types.ObjectId(), new Types.ObjectId()];
    const started = new Date('2026-01-01T00:00:00.000Z');
    const couple = await Couple.create({ memberIds: members, savingsWriteToken: 'fixture-held-token', savingsWriteStartedAt: started });
    const ids = Array.from({ length: 5 }, (_, i) => new Types.ObjectId(`00000000000000000000000${i + 1}`));
    const statuses = ['active', 'reached', 'active', 'reached', 'closed'] as const;
    const amounts = [100000, 0, 0, 100000, 100000];
    for (let i = 0; i < ids.length; i++) {
      await SavingsGoal.create({ _id: ids[i], coupleId: couple._id, createdBy: members[0], title: i === 0 ? 'Literal .*' : `Goal ${i}`,
        emoji: 'x', targetVnd: 100000, status: statuses[i], reachedAt: statuses[i] === 'reached' ? started : null,
        appliedProposalIds: [ids[i]], createdAt: started, updatedAt: started });
      if (amounts[i]) await SavingsEntry.create({ coupleId: couple._id, goalId: ids[i], userId: members[0], amountVnd: amounts[i], occurredOn: '2026-01-01', source: 'manual' });
    }
    // Deleted and foreign-couple amounts must not affect the balance.
    await SavingsEntry.create({ coupleId: couple._id, goalId: ids[1], userId: members[0], amountVnd: 100000, occurredOn: '2026-01-01', source: 'manual', deletedAt: started });
    await SavingsEntry.create({ coupleId: new Types.ObjectId(), goalId: ids[1], userId: members[0], amountVnd: 100000, occurredOn: '2026-01-01', source: 'manual' });
    const expected = { all: [4, 3, 2, 1, 0], open: [3, 2, 1, 0], active: [2, 1], reached: [3, 0], closed: [4] } as const;
    for (const status of ['all', 'open', 'active', 'reached', 'closed'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await savingsService.list(couple, { status, limit: 1, cursor });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        assert.ok(seen.length <= 5, 'cursor repeated');
      } while (cursor);
      assert.deepEqual(seen, expected[status].map((i) => ids[i].toString()));
    }
    for (let i = 0; i < ids.length; i++) {
      const detail = await savingsService.detail(couple, members[0].toString(), ids[i].toString());
      assert.equal(detail.goal.status, i === 4 ? 'closed' : amounts[i] >= 100000 ? 'reached' : 'active');
      assert.equal(detail.goal.reachedAt, statuses[i] === 'reached' ? started.toISOString() : null);
    }
    const literal = await savingsService.list(couple, { status: 'reached', q: '.*', limit: 2 });
    assert.deepEqual(literal.items.map((item) => item.id), [ids[0].toString()]);
    const after = await Couple.findById(couple._id).exec();
    assert.equal(after?.savingsWriteToken, 'fixture-held-token');
    assert.equal(after?.savingsWriteStartedAt?.toISOString(), started.toISOString());
    console.log('exclusive local savings list fixture passed');
    // Leave the synthetic database intact for inspection; never release or recover the token.
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
