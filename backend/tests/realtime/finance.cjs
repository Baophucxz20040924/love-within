'use strict';

// Actual service code with isolated repositories/providers: no dotenv, database or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Types } = require('mongoose');
const { z } = require('zod');
const root = path.resolve(__dirname, '../../src');
function load(relative, mocks) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, Date, Map, Set, setInterval, clearInterval, setTimeout,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name} in ${relative}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}
class AppError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
class BankFeedError extends Error {
  constructor(code = 'TOKEN_INVALID') { super('Mock bank failure'); this.code = code; }
}
const Errors = Object.fromEntries(['unauthorized', 'notFound', 'internal'].map((name) => [name, () => new AppError(400, name, name)]));
const logger = { info() {}, warn() {}, error() {} };
const failure = () => { throw new Error('Mock persistence failed'); };
function harness() {
  const id = new Types.ObjectId();
  const uid = id.toString();
  const user = { _id: id, financeVisibility: 'private', timezone: 'Asia/Ho_Chi_Minh', aiFinanceConsentAt: new Date() };
  const conn = { _id: new Types.ObjectId(), userId: id, tokenEnc: {}, status: 'active', provider: 'mock', bankBrand: 'mock', accountLast4: '0000' };
  const signals = [];
  const audience = {
    async own(...args) { signals.push(['own', ...args]); },
    async coupleForUser(...args) { signals.push(['couple', ...args]); },
  };
  const users = { async findById() { return user; }, async setFinanceVisibility(_id, visibility) { user.financeVisibility = visibility; }, async setAiFinanceConsent(_id, at) { user.aiFinanceConsentAt = at; } };
  const connections = {
    async findByUser() { return conn; }, async upsertActive() { return conn; }, async revoke() { return { ...conn, status: 'revoked' }; },
    async recordSuccess() { return conn; }, async recordFailure(_id, _at, _error, _threshold, _fatal, acknowledged) { acknowledged?.(); return conn; },
  };
  const txn = { _id: new Types.ObjectId(), direction: 'out', amount: 100, occurredAt: new Date(), localDate: '2026-11-14', note: 'private' };
  const txns = { async upsertMany() { return 1; }, async updateNote() { return txn; }, async deleteAllForUser() { return 1; } };
  const threads = { async deleteByUser() { return 1; }, async findByUser() { return null; }, async setInsights() {}, async appendExchange() {} };
  const feed = { async fetchRecent() { return [{ occurredAt: new Date() }]; } };
  const chat = { async complete() { return { text: 'A safe mock reply', model: 'mock' }; } };
  const snap = { coverage: { txnCount: 1 }, fingerprint: 'current' };
  const common = {
    '../repositories/user.repository.js': { userRepository: users },
    '../repositories/bankConnection.repository.js': { bankConnectionRepository: connections },
    '../repositories/bankTransaction.repository.js': { bankTransactionRepository: txns },
    '../repositories/assistantThread.repository.js': { assistantThreadRepository: threads },
    '../integrations/index.js': { getBankFeed: () => feed, getChat: () => chat },
    '../integrations/bank/BankFeedProvider.js': { BankFeedError },
    '../utils/errors.js': { AppError, Errors }, '../utils/logger.js': { logger },
    '../utils/date.js': { getLocalDate: () => '2026-11-14' },
    '../utils/crypto.js': { encryptSecret: () => ({}), decryptSecret: () => 'mock', assertSecretKey() {} },
    './realtimeAudience.service.js': { realtimeAudience: audience }, mongoose: { Types },
  };
  const publish = load('services/financeRealtime.service.ts', common).publishFinanceChange;
  const sync = load('services/bankSync.service.ts', { ...common,
    '../config/env.js': { env: { bank: { pollIntervalSec: 60 } } },
    './financeRealtime.service.js': { publishFinanceChange: publish },
  }).bankSyncService;
  const finance = load('services/finance.service.ts', { ...common,
    './bankSync.service.js': { bankSyncService: sync }, './financeRealtime.service.js': { publishFinanceChange: publish },
  }).financeService;
  const assistant = load('services/assistant.service.ts', { ...common, zod: { z },
    '../integrations/ai/ChatProvider.js': { ChatProviderError: class extends Error {} },
    '../models/AssistantThread.js': { MAX_ASSISTANT_REPLY: 4000, SPEND_CATEGORIES: ['other'] },
    './assistantContext.service.js': { buildSnapshot: async () => snap, categoryBreakdown: () => [], renderDataBlock: () => '', renderNoteList: () => ({ text: '', keys: [] }) },
  }).assistantService;
  return { uid, user, conn, signals, users, connections, txns, threads, feed, chat, snap, publish, sync, finance, assistant, audience };
}
function ownOnly(h, label) {
  assert.ok(h.signals.length, `${label}: missing signal`);
  assert.ok(h.signals.every(([kind, id, space]) => kind === 'own' && id === h.uid && space === 'couple'), `${label}: private activity escaped owner`);
}
(async () => {
  let checks = 0;
  async function test(name, fn) { await fn(harness()); checks++; }
  await test('private note', async (h) => { await h.finance.setNote(h.uid, 'txn', 'note'); ownOnly(h, 'note'); });
  await test('shared note', async (h) => { h.user.financeVisibility = 'partner'; await h.finance.setNote(h.uid, 'txn', 'note'); assert.ok(h.signals.some(([kind]) => kind === 'couple')); });
  await test('no matched note', async (h) => { h.txns.updateNote = async () => null; await assert.rejects(h.finance.setNote(h.uid, 'txn', 'note')); assert.equal(h.signals.length, 0); });
  await test('visibility revoke', async (h) => { await h.finance.setVisibility(h.uid, 'private'); assert.ok(h.signals.some(([kind, , domains, access]) => kind === 'couple' && domains.includes('finance') && access)); });
  await test('failed visibility', async (h) => { h.users.setFinanceVisibility = failure; await assert.rejects(h.finance.setVisibility(h.uid, 'partner')); assert.equal(h.signals.length, 0); });
  await test('connect rejected before write', async (h) => { h.connections.findByUser = async () => null; h.feed.fetchRecent = async () => { throw new BankFeedError(); }; await assert.rejects(h.finance.connect(h.uid, { token: 'mock', accountLast4: '0000' })); assert.equal(h.signals.length, 0); });
  await test('connect persisted then import fails', async (h) => { h.connections.findByUser = async () => null; h.sync.ingest = failure; await assert.rejects(h.finance.connect(h.uid, { token: 'mock', accountLast4: '0000' })); ownOnly(h, 'partial connect'); });
  await test('disconnect persisted then purge fails', async (h) => { h.txns.deleteAllForUser = failure; await assert.rejects(h.finance.disconnect(h.uid, true)); ownOnly(h, 'partial disconnect'); assert.equal(h.signals[0][4], true); });
  await test('sync cooldown no write', async (h) => { h.conn.lastPolledAt = new Date(); const r = await h.finance.syncNow(h.uid); assert.equal(r.synced, false); assert.equal(h.signals.length, 0); });
  await test('background sync successful', async (h) => { assert.equal((await h.sync.syncConnection(h.conn)).ok, true); ownOnly(h, 'sync'); });
  await test('background provider failure persisted', async (h) => { h.feed.fetchRecent = async () => { throw new BankFeedError(); }; assert.equal((await h.sync.syncConnection(h.conn)).ok, false); ownOnly(h, 'failure state'); });
  await test('background no acknowledged write', async (h) => { h.feed.fetchRecent = failure; h.connections.recordFailure = failure; await assert.rejects(h.sync.syncConnection(h.conn)); assert.equal(h.signals.length, 0); });
  await test('background partial insert and bookkeeping failure', async (h) => { h.connections.recordSuccess = failure; h.connections.recordFailure = failure; await assert.rejects(h.sync.syncConnection(h.conn)); ownOnly(h, 'partial import'); });
  await test('unordered bulk partial insert', async (h) => { h.txns.upsertMany = async () => { throw Object.assign(new Error('bulk'), { result: { upsertedCount: 1 } }); }; h.connections.recordFailure = failure; await assert.rejects(h.sync.syncConnection(h.conn)); ownOnly(h, 'bulk partial'); });
  await test('failure status second write fails', async (h) => { h.feed.fetchRecent = failure; h.connections.recordFailure = async (...args) => { args[5](); failure(); }; await assert.rejects(h.sync.syncConnection(h.conn)); ownOnly(h, 'partial failure status'); });
  await test('revoked skip', async (h) => { h.conn.status = 'revoked'; await h.sync.syncConnection(h.conn); assert.equal(h.signals.length, 0); });
  await test('publisher failure does not fail finance', async (h) => { h.audience.own = failure; await h.finance.setNote(h.uid, 'txn', 'note'); });
  await test('consent owner-only even with shared finance', async (h) => { h.user.financeVisibility = 'partner'; await h.assistant.consent(h.uid); ownOnly(h, 'consent'); });
  await test('clear partial delete', async (h) => { h.users.setAiFinanceConsent = failure; await assert.rejects(h.assistant.clear(h.uid, true)); ownOnly(h, 'partial clear'); assert.equal(h.signals[0][4], true); });
  await test('chat saved owner-only', async (h) => { h.user.financeVisibility = 'partner'; await h.assistant.chat(h.uid, 'mock'); ownOnly(h, 'chat'); });
  await test('chat save rejected', async (h) => { h.threads.appendExchange = failure; await assert.rejects(h.assistant.chat(h.uid, 'mock')); assert.equal(h.signals.length, 0); });
  await test('cached insight does not publish', async (h) => { h.threads.findByUser = async () => ({ insights: { fingerprint: 'current', generatedAt: new Date(), headline: '', observations: [], suggestions: [], categories: [] } }); await h.assistant.insights(h.uid, false); assert.equal(h.signals.length, 0); });
  await test('insight persisted owner-only', async (h) => { h.chat.complete = async () => ({ text: '{"headline":"mock"}', model: 'mock' }); await h.assistant.insights(h.uid, true); ownOnly(h, 'insights'); });
  await test('assistant rejects no data', async (h) => { h.snap.coverage.txnCount = 0; await assert.rejects(h.assistant.chat(h.uid, 'mock')); assert.equal(h.signals.length, 0); });
  console.log(`PASS: ${checks} realtime finance/assistant scenarios (actual services, mocked persistence/providers; no network/DB).`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
