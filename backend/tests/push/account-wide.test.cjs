'use strict';
// Mock-only unit tests: no server, database, environment files or push provider are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const mongoose = require('mongoose');
const { Types } = mongoose;
const { z } = require('zod');

function load(relative, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, URL, Buffer, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return mod.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const endpoint = 'https://fcm.googleapis.com/mock-device';
const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
const generic = { title: 'Love Within', body: 'Bạn có một thông báo mới', url: '/', tag: 'notification' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function repositoryHarness() {
  const calls = [];
  let result = [];
  let failures = [];
  const model = {};
  for (const method of ['find', 'findOne', 'findOneAndUpdate', 'deleteMany', 'deleteOne', 'updateOne']) {
    model[method] = (...args) => {
      calls.push({ method, args });
      const query = {};
      for (const step of ['sort', 'skip', 'select', 'lean']) query[step] = (...values) => {
        calls.push({ method: step, args: values });
        return query;
      };
      query.exec = async () => {
        if (failures.length) throw failures.shift();
        return typeof result === 'function' ? result(method, args) : result;
      };
      return query;
    };
  }
  const { pushSubscriptionRepository: repo } = load('repositories/pushSubscription.repository.ts', {
    '../models/PushSubscription.js': { PushSubscription: model },
    '../utils/errors.js': load('utils/errors.ts', {}),
  });
  return { repo, calls, setResult: value => result = value, setFailures: value => failures = value };
}

test('model permits space-free and legacy rows, retains unique endpoint and legacy indexes', () => {
  const { PushSubscription } = load('models/PushSubscription.ts', { mongoose });
  for (const space of [undefined, 'couple', 'friends']) {
    const doc = new PushSubscription({ userId: new Types.ObjectId(), endpoint, keys, ...(space ? { space } : {}) });
    assert.equal(doc.validateSync(), undefined);
  }
  const indexes = plain(PushSubscription.schema.indexes());
  assert.ok(indexes.some(([key, opts]) => key.endpoint === 1 && opts.unique));
  assert.ok(indexes.some(([key]) => key.userId === 1 && key.space === 1 && key.updatedAt === -1));
  assert.ok(indexes.some(([key]) => key.userId === 1 && key.space === undefined && key.updatedAt === -1));
});

test('repository reads all account devices and prunes account-wide with ownership recheck', async () => {
  const h = repositoryHarness();
  const userId = new Types.ObjectId();
  const oldId = new Types.ObjectId();
  await h.repo.listFor(userId);
  assert.deepEqual(plain(h.calls), [
    { method: 'find', args: [{ userId: String(userId) }] },
    { method: 'select', args: ['userId credentialVersion endpoint keys'] },
    { method: 'lean', args: [] },
  ]);
  h.calls.length = 0;
  h.setResult(method => method === 'find' ? [{ _id: oldId }] : { deletedCount: 1 });
  assert.equal(await h.repo.pruneOldest(userId, 10), 1);
  assert.deepEqual(plain(h.calls), [
    { method: 'find', args: [{ userId: String(userId) }] },
    { method: 'sort', args: [{ updatedAt: -1 }] },
    { method: 'skip', args: [10] },
    { method: 'select', args: ['_id'] },
    { method: 'lean', args: [] },
    { method: 'deleteMany', args: [{ userId: String(userId), _id: { $in: [String(oldId)] } }] },
  ]);
  h.calls.length = 0;
  h.setResult([]);
  assert.equal(await h.repo.pruneOldest(userId, 10), 0);
  assert.ok(!h.calls.some(call => call.method === 'deleteMany'));
});

test('upsert stays endpoint-unique, ignores legacy space, and retries duplicate insert races', async () => {
  const h = repositoryHarness();
  const userId = new Types.ObjectId();
  h.setResult({ userId, endpoint });
  h.setFailures([{ code: 11000 }]);
  await h.repo.upsert({ userId, credentialVersion: 0, endpoint, keys, userAgent: 'iPhone', space: 'friends' });
  assert.equal(h.calls.length, 2);
  for (const [index, call] of h.calls.entries()) {
    assert.deepEqual(plain(call.args), [
      { endpoint, $or: [{ userId: { $ne: String(userId) } }, { credentialVersion: { $lte: 0 } }, { credentialVersion: { $exists: false } }] },
      { $set: { userId: String(userId), credentialVersion: 0, keys, userAgent: 'iPhone', failCount: 0 } },
      index === 0 ? { upsert: true, new: true, setDefaultsOnInsert: true } : { new: true },
    ]);
  }
  h.setFailures([new Error('storage unavailable')]);
  await assert.rejects(() => h.repo.upsert({ userId, credentialVersion: 0, endpoint, keys, userAgent: '' }), /storage unavailable/);
});

test('findOwn and deleteOwn always qualify endpoint with authenticated owner', async () => {
  const h = repositoryHarness();
  const userId = new Types.ObjectId();
  h.setResult(null);
  assert.equal(await h.repo.findOwn(userId, endpoint), null);
  h.setResult({ deletedCount: 0 });
  assert.equal(await h.repo.deleteOwn(userId, endpoint), false);
  h.setResult({ deletedCount: 1 });
  assert.equal(await h.repo.deleteOwn(userId, endpoint), true);
  for (const call of h.calls) assert.deepEqual(plain(call.args[0]), { userId: String(userId), endpoint });
});

function serviceHarness(globals = {}) {
  const defaults = {
    couple: { approvals: true, stories: true, reminders: true, nudges: true, moments: true, preview: true },
    friends: { social: true, events: true, messages: true, preview: false },
    quiet: { enabled: false, from: '23:00', to: '07:00' },
  };
  const userId = new Types.ObjectId();
  const state = {
    settings: structuredClone(defaults), member: true, membershipChecks: 0, actorLookups: 0,
    credentialVersion: 0, mustChangePassword: false, credentialChecks: 0,
    clock: Date.parse('2026-11-15T09:00:00Z'), timezone: 'UTC',
    devices: [
      { _id: new Types.ObjectId(), userId, endpoint, keys, space: 'couple' },
      { _id: new Types.ObjectId(), userId, endpoint: `${endpoint}-friends`, keys, space: 'friends' },
      { _id: new Types.ObjectId(), userId, endpoint: `${endpoint}-new`, keys },
    ],
  };
  const calls = { send: [], list: [], upsert: [], prune: [], find: [], remove: [], settings: [], success: [], gone: [] };
  const provider = {
    enabled: true, publicKey: 'mock-public-key',
    async send(sub, payload, opts) {
      calls.send.push({ sub, payload: JSON.parse(payload), opts: plain(opts) });
      return { status: 'ok' };
    },
  };
  const repo = {
    async listFor(...args) { calls.list.push(args); return state.devices; },
    async upsert(input) { calls.upsert.push(input); },
    async pruneOldest(...args) { calls.prune.push(args); return 0; },
    async findOwn(...args) { calls.find.push(args); return state.devices.find(sub => sub.endpoint === args[1]) || null; },
    async deleteOwn(...args) { calls.remove.push(args); return false; },
    async markSuccess(id) { calls.success.push(id); },
    async deleteById(id) { calls.gone.push(id); },
    async incFail() { return 1; },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.clock])); }
    static now() { return state.clock; }
  }
  const exports = load('services/push.service.ts', {
    mongoose: { Types },
    '../config/notificationTypes.js': load('config/notificationTypes.ts', {}),
    '../integrations/index.js': { getPush: () => provider },
    '../models/User.js': { DEFAULT_PUSH_SETTINGS: defaults },
    '../repositories/pushSubscription.repository.js': { pushSubscriptionRepository: repo },
    '../repositories/user.repository.js': { userRepository: {
      async findPushProfile() { return { pushSettings: state.settings, timezone: state.timezone }; },
      async findDisplayNames() { state.actorLookups++; throw new Error('Actor lookup forbidden'); },
      async isFriendsMember() { state.membershipChecks++; return state.member; },
      async setPushSettings(_id, fields) {
        calls.settings.push(fields);
        for (const [key, value] of Object.entries(fields)) {
          const [group, setting] = key.split('.');
          state.settings[group][setting] = value;
        }
      },
    } },
    '../utils/date.js': load('utils/date.ts', {}),
    '../utils/errors.js': load('utils/errors.ts', {}),
    '../utils/logger.js': { logger: { debug() {}, info() {}, warn() {} } },
    './credential.service.js': { credentialService: { async assertApp(id, version) {
      state.credentialChecks++;
      if (id !== String(userId) || version !== state.credentialVersion || state.mustChangePassword) {
        const error = new Error('revoked'); error.status = 401; throw error;
      }
    } } },
  }, { Date: Clock, setTimeout, clearTimeout, ...globals });
  const service = exports.pushService;
  const job = space => ({
    userId, space, group: space === 'couple' ? 'stories' : 'social', type: 'private-event',
    actorId: new Types.ObjectId(), content: { body: 'private message', url: `/${space}/stories/private-id`, tag: `${space}:private-id` },
  });
  const drain = async () => {
    for (let i = 0; i < 500 && service.pendingCount(); i++) await tick();
    assert.equal(service.pendingCount(), 0, 'background delivery finished');
  };
  return { service, state, calls, provider, repo, userId, job, drain, ...exports };
}

test('both job spaces fan out to all account devices including legacy and space-free rows', async () => {
  const h = serviceHarness();
  h.service.enqueue(h.job('couple'));
  h.service.enqueue(h.job('friends'));
  await h.drain();
  assert.equal(h.calls.send.length, 6);
  for (const device of h.state.devices) assert.equal(h.calls.send.filter(call => call.sub.endpoint === device.endpoint).length, 2);
  for (const args of h.calls.list) assert.deepEqual(args, [h.userId]);
  for (const call of h.calls.send) {
    assert.deepEqual(call.payload, generic);
    assert.deepEqual(call.opts, { ttlSec: 86400, urgency: 'normal' });
  }
});

test('preview true and false never invoke body formatters or actor lookups and never expose event data', async () => {
  const h = serviceHarness();
  let formatCalls = 0;
  for (const space of ['couple', 'friends']) {
    for (const preview of [true, false]) {
      await h.service.updateSettings(String(h.userId), { space, preview });
      assert.equal((await h.service.getSettings(String(h.userId), space)).preview, preview);
      const job = h.job(space);
      job.content.body = () => { formatCalls++; throw new Error('Formatter forbidden'); };
      h.service.enqueue(job);
      await h.drain();
    }
  }
  assert.equal(h.calls.send.length, 12);
  assert.equal(formatCalls, 0);
  assert.equal(h.state.actorLookups, 0);
  for (const call of h.calls.send) assert.deepEqual(call.payload, generic);
});

test('group switches follow job.space while devices stay account-wide', async () => {
  const h = serviceHarness();
  h.state.settings.couple.stories = false;
  h.service.enqueue(h.job('couple'));
  h.service.enqueue(h.job('friends'));
  await h.drain();
  assert.equal(h.calls.send.length, 3);
  h.calls.send.length = 0;
  h.state.settings.couple.stories = true;
  h.state.settings.friends.social = false;
  h.service.enqueue(h.job('couple'));
  h.service.enqueue(h.job('friends'));
  await h.drain();
  assert.equal(h.calls.send.length, 3);
});

test('shared quiet hours suppress both spaces in the profile timezone, including urgent jobs', async () => {
  const h = serviceHarness();
  h.state.settings.quiet.enabled = true;
  h.state.clock = Date.parse('2026-11-15T16:00:00Z'); // 23:00 in Vietnam
  h.state.timezone = 'Asia/Ho_Chi_Minh';
  for (const space of ['couple', 'friends']) h.service.enqueue({ ...h.job(space), urgent: true });
  await h.drain();
  assert.equal(h.calls.send.length, 0);
  h.state.clock = Date.parse('2026-11-16T00:00:00Z'); // exclusive end, 07:00
  for (const space of ['couple', 'friends']) h.service.enqueue(h.job(space));
  await h.drain();
  assert.equal(h.calls.send.length, 6);
});

test('subscribe accepts omitted or legacy space without membership checks; settings retain friends ACL', async () => {
  const h = serviceHarness();
  h.state.member = false;
  for (const space of [undefined, 'couple', 'friends']) {
    const result = await h.service.subscribe(String(h.userId), { endpoint, keys, ...(space ? { space } : {}) }, 'iPhone Safari/', 0);
    assert.deepEqual(plain(result), { device: 'iPhone · Safari' });
  }
  assert.equal(h.state.membershipChecks, 0);
  for (const input of h.calls.upsert) {
    assert.deepEqual(plain(input), { userId: String(h.userId), credentialVersion: 0, endpoint, keys, userAgent: 'iPhone · Safari' });
  }
  for (const args of h.calls.prune) assert.deepEqual(plain(args), [String(h.userId), 10]);
  await assert.rejects(() => h.service.getSettings(String(h.userId), 'friends'), error => error.status === 403);
  await assert.rejects(() => h.service.updateSettings(String(h.userId), { space: 'friends', preview: true }), error => error.status === 403);
  assert.equal(h.calls.settings.length, 0);
  assert.equal((await h.service.getSettings(String(h.userId), 'couple')).space, 'couple');
  assert.deepEqual(plain(await h.service.unsubscribe(String(h.userId), endpoint)), { removed: false });
  assert.deepEqual(plain(h.calls.remove[0]), [String(h.userId), endpoint]);
});

test('device tests are generic for legacy and new subscriptions, owner-qualified, and ignore quiet/groups', async () => {
  const h = serviceHarness();
  h.state.settings.quiet = { enabled: true, from: '08:00', to: '10:00' };
  h.state.settings.couple.stories = false;
  h.state.settings.friends.social = false;
  for (const sub of h.state.devices) {
    assert.deepEqual(plain(await h.service.test(String(h.userId), sub.endpoint)), { sent: true });
  }
  assert.equal(h.calls.send.length, 3);
  for (const call of h.calls.send) {
    assert.deepEqual(call.payload, generic);
    assert.deepEqual(call.opts, { ttlSec: 600, urgency: 'normal' });
  }
  assert.equal(h.calls.list.length, 0);
  for (const args of h.calls.find) assert.equal(String(args[0]), String(h.userId));
  await assert.rejects(() => h.service.test(String(h.userId), 'https://fcm.googleapis.com/someone-else'), error => error.status === 404);
  assert.equal(h.calls.send.length, 3);
});

test('timed and urgent jobs retain TTL/urgency while expiry is the only optional event payload field', async () => {
  const h = serviceHarness();
  const expiresAt = '2026-11-15T09:30:00Z';
  const job = { ...h.job('couple'), timed: true, urgent: true };
  h.service.enqueue(job);
  await h.drain();
  assert.deepEqual(h.calls.send[0].opts, { ttlSec: 14400, urgency: 'high' });
  h.calls.send.length = 0;
  job.content.expiresAt = expiresAt;
  h.service.enqueue(job);
  await h.drain();
  for (const call of h.calls.send) {
    assert.deepEqual(call.payload, { ...generic, expiresAt });
    assert.deepEqual(call.opts, { ttlSec: 1800, urgency: 'high' });
  }
});

test('reset stops delivery to legacy registrations and rejects stale subscribe', async () => {
  const h = serviceHarness();
  h.state.credentialVersion = 1;
  h.state.mustChangePassword = true;
  h.service.enqueue(h.job('couple'));
  await h.drain();
  assert.equal(h.calls.send.length, 0);
  await assert.rejects(() => h.service.subscribe(String(h.userId), { endpoint, keys }, undefined, 0), e => e.status === 401);
  assert.equal(h.calls.upsert.length, 0);
  h.state.mustChangePassword = false;
  h.service.enqueue(h.job('friends'));
  await h.drain();
  assert.equal(h.calls.send.length, 0);
  h.state.devices[0].credentialVersion = 1;
  h.service.enqueue(h.job('couple'));
  await h.drain();
  assert.equal(h.calls.send.length, 1);
});

test('a reset during the first device batch blocks all later batches', async () => {
  const h = serviceHarness();
  h.state.devices = Array.from({ length: 8 }, (_, i) => ({ _id: new Types.ObjectId(), userId: h.userId, credentialVersion: 0, endpoint: `${endpoint}-${i}`, keys }));
  h.provider.send = async (sub) => {
    h.calls.send.push(sub);
    h.state.credentialVersion = 1;
    h.state.mustChangePassword = true;
    return { status: 'ok' };
  };
  h.service.enqueue(h.job('couple'));
  await h.drain();
  assert.equal(h.calls.send.length, 5, 'only the already-authorized parallel batch can finish');
  await assert.rejects(() => h.service.test(String(h.userId), h.state.devices[0].endpoint), e => e.code === 'PUSH_STALE');
});

test('push drain closes admission, joins active and queued work and is idempotent', async () => {
  const h = serviceHarness();
  let release;
  const gate = new Promise(resolve => release = resolve);
  h.repo.listFor = async () => { await gate; return []; };
  for (let i = 0; i < 30; i++) h.service.enqueue(h.job('couple'));
  assert.equal(h.service.pendingCount(), 30);
  const first = h.drainPush();
  assert.equal(h.drainPush(), first);
  h.service.enqueue(h.job('friends'));
  assert.equal(h.service.pendingCount(), 30);
  let finished = false; void first.then(() => finished = true);
  await tick(); assert.equal(finished, false);
  release(); await first;
  assert.equal(h.service.pendingCount(), 0);
  h.service.enqueue(h.job('couple')); assert.equal(h.service.pendingCount(), 0);
  await serviceHarness().drainPush();
});

test('push drain timeout does not clear real pending work or reopen admission', async () => {
  let timeout;
  const h = serviceHarness({ setTimeout(fn, ms) { assert.equal(ms, 10000); timeout = fn; return 1; }, clearTimeout() {} });
  let release; const gate = new Promise(resolve => release = resolve);
  h.repo.listFor = async () => { await gate; return []; };
  h.service.enqueue(h.job('couple'));
  const joined = h.drainPush(); timeout(); await joined;
  assert.equal(h.service.pendingCount(), 1);
  h.service.enqueue(h.job('friends')); assert.equal(h.service.pendingCount(), 1);
  release(); await h.drain(); assert.equal(h.service.pendingCount(), 0);
});

test('subscription route accepts no space and both legacy spaces; settings still require valid space', () => {
  const routes = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'delete', 'patch']) router[method] = (route, ...handlers) => routes.push({ method, route, handlers });
  load('routes/push.routes.ts', {
    express: { Router: () => router }, zod: { z },
    '../middleware/errorHandler.js': { asyncHandler: handler => handler },
    '../middleware/auth.js': { requireAuth() {} },
    '../middleware/validate.js': { validate: schemas => ({ schemas }) },
    '../middleware/rateLimit.js': { pushSubscribeLimiter() {}, pushTestLimiter() {} },
    '../models/PushSubscription.js': { PUSH_SPACES: ['couple', 'friends'] },
    '../services/push.service.js': { pushService: {} },
    '../utils/response.js': { ok() {} },
  });
  const schema = (method, route, part) => routes.find(row => row.method === method && row.route === route).handlers.find(handler => handler.schemas).schemas[part];
  const subscribe = schema('post', '/subscriptions', 'body');
  for (const space of [undefined, 'couple', 'friends']) assert.ok(subscribe.safeParse({ endpoint, keys, ...(space ? { space } : {}) }).success);
  assert.equal(subscribe.safeParse({ endpoint, keys, space: 'invalid' }).success, false);
  const patch = schema('patch', '/settings', 'body');
  assert.equal(patch.safeParse({ preview: true }).success, false);
  assert.ok(patch.safeParse({ space: 'friends', preview: true, groups: { social: false } }).success);
  assert.equal(patch.safeParse({ space: 'friends', groups: { stories: false } }).success, false);
  assert.equal(schema('get', '/settings', 'query').safeParse({}).success, false);
});
