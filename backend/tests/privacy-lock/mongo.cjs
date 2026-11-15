'use strict';
// Explicit opt-in. Connects only to the permitted local development database; no app server or providers.
if (process.argv.length !== 3 || process.argv[2] !== '--local-lookwithin-dev') {
  throw new Error('Explicit --local-lookwithin-dev opt-in required');
}
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { PrivacyLock } = require('../../dist/models/PrivacyLock.js');
const { User } = require('../../dist/models/User.js');
const { privacyLockService: service } = require('../../dist/services/privacyLock.service.js');
const URI = 'mongodb://127.0.0.1:27017/lookwithin_dev';
const tag = `privacy-lock-test-${crypto.randomUUID()}`;
const ids = [];
const originalCompare = bcrypt.compare;
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const rejects = async (fn, status, code) => assert.rejects(fn, e => e.status === status && (!code || e.code === code));

async function createUser(suffix) {
  const _id = new mongoose.Types.ObjectId();
  ids.push(_id);
  await User.create({ _id, email: `${tag}-${suffix}@example.invalid`, displayName: tag, passwordHash: await bcrypt.hash('integration-password', 4), friendsJoinedAt: new Date() });
  return _id.toString();
}
async function run() {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000, autoIndex: false });
  assert.equal(mongoose.connection.name, 'lookwithin_dev');
  const a = await createUser('a');
  assert.deepEqual(await service.status(a), { couple: false, friends: false, revision: 0 });
  await rejects(() => service.unlock(a, '012345'), 400, 'INVALID_PIN');
  let doc = await PrivacyLock.findOne({ userId: a }).select('+unlockBudget +reauthBudget +coupleHash +friendsHash').lean();
  assert.equal(doc.unlockBudget.failures, 1);
  assert.equal(doc.unlockBudget.leaseId, null);
  assert.equal(doc.reauthBudget.failures, 0);
  assert.deepEqual(await service.configure(a, 'couple', 'integration-password', 0, '012345'), { couple: true, friends: false, revision: 1 });
  await service.configure(a, 'friends', 'integration-password', 1, '123456');
  await rejects(() => service.configure(a, 'friends', 'integration-password', 2, '012345'), 400);
  assert.deepEqual(await service.unlock(a, '012345'), { space: 'couple', revision: 2 });
  assert.deepEqual(await service.unlock(a, '123456'), { space: 'friends', revision: 2 });
  for (let i = 0; i < 5; i++) await rejects(() => service.unlock(a, '999999'), 400, 'INVALID_PIN');
  doc = await PrivacyLock.findOne({ userId: a }).select('+unlockBudget').lean();
  assert.equal(doc.unlockBudget.failures, 5);
  assert.ok(doc.unlockBudget.blockedUntil.getTime() > Date.now());
  await assert.rejects(() => service.unlock(a, '012345'), e => e.status === 429 && e.details.retryAfterSeconds >= 1 && e.details.retryAfterSeconds <= 30);
  // Change the stored deadline only on our own test record, simulating elapsed time across service callers.
  await PrivacyLock.updateOne({ userId: a }, { $set: { 'unlockBudget.blockedUntil': new Date(Date.now() - 1) } });
  await rejects(() => service.unlock(a, '999999'), 400, 'INVALID_PIN');
  doc = await PrivacyLock.findOne({ userId: a }).select('+unlockBudget').lean();
  assert.equal(doc.unlockBudget.failures, 6);
  assert.ok(doc.unlockBudget.blockedUntil.getTime() - Date.now() > 55_000);
  await PrivacyLock.updateOne({ userId: a }, { $set: { 'unlockBudget.blockedUntil': new Date(Date.now() - 1) } });
  await service.unlock(a, '012345');
  doc = await PrivacyLock.findOne({ userId: a }).select('+unlockBudget').lean();
  assert.equal(doc.unlockBudget.failures, 0);

  // Keep first caller inside bcrypt: the second caller must fail before doing work.
  const entered = pause(), release = pause();
  bcrypt.compare = async (...args) => {
    if (args[0] === '012345') { entered.resolve(); await release.promise; }
    return originalCompare(...args);
  };
  const first = service.unlock(a, '012345');
  await entered.promise;
  try { await rejects(() => service.unlock(a, '123456'), 429); } finally { release.resolve(); }
  assert.equal((await first).space, 'couple');
  bcrypt.compare = originalCompare;

  // Modify configuration while a correct unlock is in flight; old match must not grant.
  const entered2 = pause(), release2 = pause();
  bcrypt.compare = async (...args) => {
    if (args[0] === '012345') { entered2.resolve(); await release2.promise; }
    return originalCompare(...args);
  };
  const stale = service.unlock(a, '012345');
  await entered2.promise;
  try { await service.configure(a, 'couple', 'integration-password', 2, '555555'); }
  finally { release2.resolve(); }
  await rejects(() => stale, 409);
  bcrypt.compare = originalCompare;
  assert.equal((await service.unlock(a, '555555')).revision, 3);

  // Both config writers read the same revision and choose the same new PIN. Exactly one wins CAS.
  const b = await createUser('b');
  const ready = pause(), go = pause();
  let duplicateChecks = 0;
  bcrypt.compare = async (...args) => {
    if (args[0] === '777777') {
      if (++duplicateChecks === 2) ready.resolve();
      await go.promise;
    }
    return originalCompare(...args);
  };
  const write1 = service.configure(b, 'couple', 'integration-password', 0, '777777');
  // First writer has already released its reauthentication lease when it reaches this comparison.
  while (duplicateChecks === 0) await new Promise(r => setTimeout(r, 10));
  const write2 = service.configure(b, 'friends', 'integration-password', 0, '777777');
  await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('configuration race timed out')), 10000))]);
  go.resolve();
  const outcomes = await Promise.allSettled([write1, write2]);
  bcrypt.compare = originalCompare;
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason.status === 409).length, 1);
  const status = await service.status(b);
  assert.equal(status.revision, 1);
  assert.notEqual(status.couple, status.friends);
  console.log('PASS real Mongo privacy lock integration (reservations, lockout, leases, stale unlock and config CAS)');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  bcrypt.compare = originalCompare;
  if (mongoose.connection.readyState === 1) {
    await PrivacyLock.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids }, email: { $regex: `^${tag}` } });
  }
  await mongoose.disconnect();
});
