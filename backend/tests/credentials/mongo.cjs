'use strict';
// Explicit opt-in, one hardcoded local DB, synthetic tagged users only; NEVER bootstraps or touches the admin email.
if (process.argv.length !== 3 || process.argv[2] !== '--local-lookwithin-dev') throw new Error('Explicit --local-lookwithin-dev opt-in required');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const root = path.resolve(__dirname, '../../dist');
const envPath = require.resolve(path.join(root, 'config/env.js'));
require.cache[envPath] = { id: envPath, filename: envPath, loaded: true, exports: {
  env: { jwt: { accessSecret: 'synthetic-local-integration-access', refreshSecret: 'synthetic-local-integration-refresh', accessTtl: '15m', refreshTtl: '30d' } }, isProd: false,
} };
const realtimePath = require.resolve(path.join(root, 'services/realtime.service.js'));
require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { realtimeService: { revokeUser() {} } } };
const loggerPath = require.resolve(path.join(root, 'utils/logger.js'));
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { logger: { info() {}, error() {} } } };
const { User } = require(path.join(root, 'models/User.js'));
const { userRepository: repo } = require(path.join(root, 'repositories/user.repository.js'));
const { credentialService: credentials } = require(path.join(root, 'services/credential.service.js'));
const { authService: auth } = require(path.join(root, 'services/auth.service.js'));
const { tokenService: tokens } = require(path.join(root, 'services/token.service.js'));
const URI = 'mongodb://127.0.0.1:27017/lookwithin_dev';
const tag = `credential-cas-test-${crypto.randomUUID()}`;
const ids = [];
const rejects401 = fn => assert.rejects(fn, e => e.status === 401);
async function createUser(suffix, legacy = false) {
  const _id = new mongoose.Types.ObjectId(); ids.push(_id);
  const doc = { _id, email: `${tag}-${suffix}@example.invalid`, displayName: tag, passwordHash: await bcrypt.hash('synthetic-original-password', 4) };
  // collection insert genuinely lacks legacy defaults; Mongoose hydration must not hide CAS behavior.
  if (legacy) await User.collection.insertOne(doc); else await User.create(doc);
  return _id.toString();
}
async function run() {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000, autoIndex: false });
  assert.equal(mongoose.connection.name, 'lookwithin_dev');
  const id = await createUser('legacy', true);
  await credentials.assertApp(id, 0);
  const oldRefresh = tokens.signRefresh(id, 0);
  const temporary = crypto.randomBytes(24).toString('base64url');
  const hash = await bcrypt.hash(temporary, 4), expiry = new Date(Date.now() + 86400000);
  const resets = await Promise.all([repo.resetPassword(id, 0, hash, expiry), repo.resetPassword(id, 0, hash, expiry)]);
  assert.equal(resets.filter(Boolean).length, 1);
  assert.equal((await User.findById(id).lean()).credentialVersion, 1);
  await rejects401(() => credentials.assertApp(id, 0));
  await rejects401(() => auth.refresh(oldRefresh));
  const user = await User.findById(id).lean();
  const limited = await auth.login({ email: user.email, password: temporary });
  assert.equal(limited.status, 'password_change_required');
  const input = { passwordChangeToken: limited.passwordChangeToken, newPassword: 'synthetic-permanent-password', confirmPassword: 'synthetic-permanent-password' };
  const completions = await Promise.allSettled([auth.completePasswordChange(input), auth.completePasswordChange(input)]);
  assert.equal(completions.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(completions.filter(x => x.status === 'rejected' && x.reason.status === 401).length, 1);
  assert.equal(tokens.verifyAccess(completions.find(x => x.status === 'fulfilled').value.accessToken).credentialVersion, 2);
  await rejects401(() => auth.completePasswordChange(input));
  const committed = await User.findById(id).lean();
  assert.equal(committed.mustChangePassword, false); assert.equal(committed.temporaryPasswordExpiresAt, null);
  assert.ok(await bcrypt.compare(input.newPassword, committed.passwordHash));

  // Actual competing database writes: reset versus completion at the same observed version.
  const raceId = await createUser('race');
  await repo.resetPassword(raceId, 0, hash, expiry);
  const nextHash = await bcrypt.hash('other-synthetic-password', 4);
  const race = await Promise.all([
    repo.resetPassword(raceId, 1, hash, expiry),
    repo.completePasswordChange(raceId, 1, expiry, nextHash, new Date(Date.now() + 900000)),
  ]);
  assert.equal(race.filter(Boolean).length, 1);
  assert.equal((await User.findById(raceId).lean()).credentialVersion, 2);

  // Server-side $$NOW also rejects a grant or temporary deadline elapsed by commit time.
  const expiredId = await createUser('expired');
  await repo.resetPassword(expiredId, 0, hash, expiry);
  assert.equal(await repo.completePasswordChange(expiredId, 1, expiry, nextHash, new Date(Date.now() - 1)), null);
  const past = new Date(Date.now() - 1);
  await User.updateOne({ _id: expiredId }, { $set: { temporaryPasswordExpiresAt: past } });
  assert.equal(await repo.completePasswordChange(expiredId, 1, past, nextHash, new Date(Date.now() + 900000)), null);
  assert.equal((await User.findById(expiredId).lean()).credentialVersion, 1);
  // A role change racing a reset makes the user-target CAS fail, even if the version is unchanged.
  await User.updateOne({ _id: expiredId }, { $set: { role: 'admin' } });
  assert.equal(await repo.resetPassword(expiredId, 1, hash, expiry), null);
  await rejects401(() => credentials.assertAdmin(expiredId, 1)); // wrong email can never grant admin
  console.log('PASS local Mongo credential CAS: legacy, reset/reset, completion once, reset/change, expiry, role checks');
}
run().catch(error => { console.error(error instanceof assert.AssertionError ? error : 'Credential Mongo integration failed'); process.exitCode = 1; }).finally(async () => {
  if (mongoose.connection.readyState === 1 && ids.length) {
    await User.deleteMany({ _id: { $in: ids }, email: { $regex: `^${tag}-` }, displayName: tag });
  }
  await mongoose.disconnect();
});
