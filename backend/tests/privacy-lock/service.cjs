'use strict';
// In-memory atomic model mock: exercises the compiled service without starting Mongo or an API server.
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { PrivacyLock } = require('../../dist/models/PrivacyLock.js');
const { User } = require('../../dist/models/User.js');
const { privacyLockService: service } = require('../../dist/services/privacyLock.service.js');
const loggerPath = require.resolve('../../dist/utils/logger.js');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { logger: { error() {} } } };
const { errorHandler } = require('../../dist/middleware/errorHandler.js');
const { AppError } = require('../../dist/utils/errors.js');
const docs = new Map();
const copy = (x) => structuredClone(x);
const budget = () => ({ failures: 0, blockedUntil: null, leaseId: null, leaseUntil: null });
const query = (v) => ({ select() { return this; }, async lean() { return v && copy(v); } });
const pathGet = (x, path) => path.split('.').reduce((a, p) => a?.[p], x);
const pathSet = (x, path, value) => { const parts = path.split('.'); const last = parts.pop(); const target = parts.reduce((a, p) => a[p], x); target[last] = value; };
let clock = 1_700_000_000_000;
const RealDate = Date;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
let passwordHash;
let joined = true;
let onNextCompare;
const originalCompare = bcrypt.compare;
bcrypt.compare = async (...args) => { if (onNextCompare) { const fn = onNextCompare; onNextCompare = null; await fn(); } return originalCompare(...args); };
User.findById = () => query({ passwordHash, friendsJoinedAt: joined ? new Date() : null });
PrivacyLock.findOne = ({ userId }) => query(docs.get(userId));
PrivacyLock.updateOne = async (filter, update, opts) => {
  let doc = docs.get(filter.userId);
  if (opts?.upsert && !doc) {
    doc = { userId: filter.userId, couple: false, friends: false, coupleHash: null, friendsHash: null, revision: 0, unlockBudget: budget(), reauthBudget: budget() };
    docs.set(filter.userId, doc);
    return { modifiedCount: 0 };
  }
  if (!doc) return { modifiedCount: 0 };
  for (const [key, expected] of Object.entries(filter)) {
    if (key === 'userId') continue;
    const actual = pathGet(doc, key);
    if (expected && typeof expected === 'object' && '$gt' in expected) { if (!(actual > expected.$gt)) return { modifiedCount: 0 }; }
    else if (actual !== expected) return { modifiedCount: 0 };
  }
  for (const [key, value] of Object.entries(update.$set ?? {})) pathSet(doc, key, value);
  for (const [key, value] of Object.entries(update.$inc ?? {})) pathSet(doc, key, pathGet(doc, key) + value);
  return { modifiedCount: 1 };
};
PrivacyLock.findOneAndUpdate = (filter, pipeline) => {
  const doc = docs.get(filter.userId);
  const set = pipeline[0].$set;
  const key = Object.keys(set)[0].split('.')[0];
  const b = doc[key];
  if ((b.blockedUntil && b.blockedUntil > new Date()) || (b.leaseUntil && b.leaseUntil > new Date())) return query(null);
  b.failures++;
  b.blockedUntil = b.failures >= 5 ? new Date(clock + Math.min(900000, 30000 * 2 ** (b.failures - 5))) : null;
  b.leaseId = set[`${key}.leaseId`];
  b.leaseUntil = set[`${key}.leaseUntil`];
  return query(doc);
};
const fails = async (fn, status) => assert.rejects(fn, e => e.status === status);
(async () => {
  passwordHash = await bcrypt.hash('password', 4);
  assert.deepEqual(await service.status('a'), { couple: false, friends: false, revision: 0 });
  await fails(() => service.configure('a', 'couple', 'wrong', 0, '000001'), 400);
  assert.deepEqual(await service.configure('a', 'couple', 'password', 0, '000001'), { couple: true, friends: false, revision: 1 });
  assert.notEqual(docs.get('a').coupleHash, '000001');
  joined = false;
  await fails(() => service.configure('a', 'friends', 'password', 1, '000002'), 403);
  joined = true;
  await fails(() => service.configure('a', 'friends', 'password', 1, '000001'), 400);
  assert.deepEqual(await service.configure('a', 'friends', 'password', 1, '000002'), { couple: true, friends: true, revision: 2 });
  assert.deepEqual(await service.unlock('a', '000001'), { space: 'couple', revision: 2 });
  assert.deepEqual(await service.unlock('a', '000002'), { space: 'friends', revision: 2 });
  await fails(() => service.configure('a', 'couple', 'password', 1, '111111'), 409);
  for (let i = 0; i < 5; i++) await fails(() => service.unlock('a', '999999'), 400);
  await assert.rejects(() => service.unlock('a', '000001'), e => e.status === 429 && e.details.retryAfterSeconds === 30);
  clock += 30000;
  await fails(() => service.unlock('a', '999999'), 400);
  await assert.rejects(() => service.unlock('a', '000001'), e => e.status === 429 && e.details.retryAfterSeconds === 60);
  clock += 60000;
  assert.equal((await service.unlock('a', '000001')).space, 'couple');
  assert.equal(docs.get('a').unlockBudget.failures, 0);
  const racers = await Promise.allSettled([
    service.configure('a', 'couple', 'password', 2, '112233'),
    service.configure('a', 'friends', 'password', 2, '112233'),
  ]);
  assert.equal(racers.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(racers.filter(x => x.status === 'rejected').length, 1);
  const activePin = docs.get('a').couple && await bcrypt.compare('112233', docs.get('a').coupleHash) ? '112233' : '000001';
  onNextCompare = async () => { const d = docs.get('a'); d.revision++; d.unlockBudget.leaseId = null; };
  await fails(() => service.unlock('a', activePin), 409);
  assert.equal(docs.get('a').unlockBudget.failures, 1);
  const d = docs.get('a');
  d.unlockBudget.leaseId = 'abandoned'; d.unlockBudget.leaseUntil = new Date(clock + 60000);
  await fails(() => service.unlock('a', '000001'), 429);
  clock += 60001;
  await service.unlock('a', activePin);
  const headers = {};
  const res = { locals: {}, headersSent: false, setHeader(k, v) { headers[k] = v; }, status() { return this; }, json() {} };
  errorHandler(new AppError(429, 'TOO_MANY_REQUESTS', 'wait', { retryAfterSeconds: 12 }), {}, res, () => {});
  assert.equal(headers['Retry-After'], '12');
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(PrivacyLock.schema.path('coupleHash').options.select, false);
  assert.equal(PrivacyLock.schema.path('friendsHash').options.select, false);
  assert.ok(PrivacyLock.schema.indexes().some(([keys, opts]) => keys.userId === 1 && opts.unique));
  console.log('PASS privacy lock service/model mock tests');
})().catch(e => { console.error(e); process.exitCode = 1; });
