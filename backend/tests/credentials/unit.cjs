'use strict';
// Pure local tests: no dotenv, Mongo, providers or HTTP listener. Uses compiled modules and synthetic data only.
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '../../dist');
function stub(file, exports) {
  const id = require.resolve(path.join(root, file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const env = { jwt: { accessSecret: 'synthetic-access-secret-only-for-unit-tests', refreshSecret: 'synthetic-refresh-secret-only-for-unit-tests', accessTtl: '15m', refreshTtl: '30d' } };
stub('config/env.js', { env, isProd: false });
const logs = [], revoked = [];
stub('utils/logger.js', { logger: { info: (...v) => logs.push(v), error() {} } });
stub('services/realtime.service.js', { realtimeService: { revokeUser: id => revoked.push(id) } });
const { User } = require(path.join(root, 'models/User.js'));
const { userRepository: repo } = require(path.join(root, 'repositories/user.repository.js'));
const { credentialService: credentials, credentialVersionOf, ADMIN_EMAIL } = require(path.join(root, 'services/credential.service.js'));
const { tokenService: tokens } = require(path.join(root, 'services/token.service.js'));
const { authService: auth } = require(path.join(root, 'services/auth.service.js'));
const { adminService: admin } = require(path.join(root, 'services/admin.service.js'));
const { bootstrapAdmin } = require(path.join(root, 'services/adminBootstrap.service.js'));
const { requireAuth, requireAdmin } = require(path.join(root, 'middleware/auth.js'));
const { newPasswordSchema, registerSchema } = require(path.join(root, 'controllers/auth.controller.js'));
const users = new Map();
const clone = x => x && ({ ...x, _id: new mongoose.Types.ObjectId(x._id.toString()) });
const version = x => x.credentialVersion ?? 0;
const isUser = x => x && (x.role === undefined || x.role === 'user') && x.email !== ADMIN_EMAIL;
repo.findCredentialsById = async id => clone(users.get(id.toString()));
repo.findById = repo.findCredentialsById;
repo.findByEmail = async email => clone([...users.values()].find(x => x.email === email.toLowerCase().trim()));
repo.findRecoveryByEmail = repo.findByEmail;
repo.create = async input => {
  const u = { _id: new mongoose.Types.ObjectId(), role: 'user', credentialVersion: 0, mustChangePassword: false, temporaryPasswordExpiresAt: null, ...input };
  users.set(u._id.toString(), u); return clone(u);
};
repo.resetPassword = async (id, expected, hash, expiry) => {
  const u = users.get(id);
  if (!isUser(u) || version(u) !== expected) return null;
  Object.assign(u, { passwordHash: hash, credentialVersion: expected + 1, mustChangePassword: true, temporaryPasswordExpiresAt: expiry });
  return clone(u);
};
repo.completePasswordChange = async (id, expected, expiry, hash, grantExpiry) => {
  const u = users.get(id);
  if (!isUser(u) || version(u) !== expected || !u.mustChangePassword || u.temporaryPasswordExpiresAt.getTime() !== expiry.getTime() || expiry <= new Date() || grantExpiry <= new Date()) return null;
  Object.assign(u, { passwordHash: hash, credentialVersion: expected + 1, mustChangePassword: false, temporaryPasswordExpiresAt: null });
  return clone(u);
};
repo.changeAdminPassword = async (id, expected, hash) => {
  const u = users.get(id);
  if (!u || u.role !== 'admin' || u.email !== ADMIN_EMAIL || version(u) !== expected) return null;
  Object.assign(u, { passwordHash: hash, credentialVersion: expected + 1 }); return clone(u);
};
const reject = (fn, status) => assert.rejects(fn, e => e.status === status);
const middleware = (handler, token) => new Promise((resolve, rejectPromise) => {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  handler(req, {}, e => e ? rejectPromise(e) : resolve(req));
});
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
async function run() {
  const ordinary = await repo.create({ email: 'user@example.invalid', displayName: 'Synthetic User', passwordHash: await bcrypt.hash('original-password', 4) });
  const uid = ordinary._id.toString();
  const adminDoc = await repo.create({ email: ADMIN_EMAIL, displayName: 'Synthetic Admin', passwordHash: await bcrypt.hash('bootstrap-only-secret', 4) });
  users.get(adminDoc._id.toString()).role = 'admin';
  const aid = adminDoc._id.toString(), actor = { userId: aid, credentialVersion: 0 };
  const old = await auth.login({ email: ordinary.email, password: 'original-password' });
  await check('new user defaults and versioned app token claims', async () => {
    assert.equal(User.schema.path('role').defaultValue, 'user');
    assert.equal(User.schema.path('credentialVersion').defaultValue, 0);
    assert.equal(jwt.decode(old.accessToken).cv, 0);
    assert.equal((await middleware(requireAuth, old.accessToken)).credentialVersion, 0);
    assert.deepEqual(Object.keys(old).sort(), ['accessToken', 'refreshToken']);
  });
  const legacy = jwt.sign({ sub: uid }, env.jwt.accessSecret, { expiresIn: '15m' });
  const legacyRefresh = jwt.sign({ sub: uid, type: 'refresh' }, env.jwt.refreshSecret, { expiresIn: '30d' });
  await check('legacy missing version accepted exactly at version zero', async () => {
    delete users.get(uid).credentialVersion;
    assert.equal(tokens.verifyAccess(legacy).credentialVersion, 0);
    await middleware(requireAuth, legacy);
    await auth.refresh(legacyRefresh);
    users.get(uid).credentialVersion = 0;
    for (const bad of [null, -1, 1.5, NaN]) assert.throws(() => credentialVersionOf({ credentialVersion: bad }));
  });
  await check('reserved register and app-admin separation', async () => {
    await reject(() => auth.register({ email: `  ${ADMIN_EMAIL.toUpperCase()} `, password: 'valid-password', displayName: 'x', role: 'admin' }), 409);
    await reject(() => auth.login({ email: ADMIN_EMAIL, password: 'bootstrap-only-secret' }), 401);
    await reject(() => admin.login({ email: ordinary.email, password: 'original-password' }), 401);
    users.get(aid).role = 'user';
    await reject(() => admin.login({ email: ADMIN_EMAIL, password: 'bootstrap-only-secret' }), 401);
    users.get(aid).role = 'admin';
    const result = await auth.register({ email: 'allowlist@example.invalid', password: 'valid-password', displayName: 'x', role: 'admin' });
    assert.equal(users.get(tokens.verifyAccess(result.accessToken).sub).role, 'user');
    assert.equal(registerSchema.parse({ email: 'a@example.invalid', password: 'valid-password', displayName: 'A', role: 'admin' }).role, undefined);
  });
  const adminLogin = await admin.login({ email: ADMIN_EMAIL, password: 'bootstrap-only-secret' });
  await check('purpose confusion denied in all directions; admin 15m without refresh', async () => {
    const limited = tokens.signPasswordChange(uid, 0, Date.now() + 86400000);
    const appTokens = [old.accessToken, old.refreshToken, adminLogin.adminToken, limited.token];
    for (let i = 0; i < appTokens.length; i++) {
      const verifiers = [tokens.verifyAccess, tokens.verifyRefresh, tokens.verifyAdmin, tokens.verifyPasswordChange];
      for (let j = 0; j < verifiers.length; j++) if (i !== j) assert.throws(() => verifiers[j](appTokens[i]), e => e.status === 401);
    }
    const payload = jwt.decode(adminLogin.adminToken);
    assert.equal(payload.exp - payload.iat, 900);
    assert.equal(adminLogin.refreshToken, undefined);
    await middleware(requireAdmin, adminLogin.adminToken);
    await reject(() => middleware(requireAuth, adminLogin.adminToken), 401);
    await reject(() => middleware(requireAdmin, old.accessToken), 401);
  });
  await check('malformed versions, future iat and unsupported purpose fail closed', async () => {
    for (const cv of [null, -1, 0.5, '0']) {
      const t = jwt.sign({ sub: uid, type: 'access', cv }, env.jwt.accessSecret, { expiresIn: '15m' });
      assert.throws(() => tokens.verifyAccess(t), e => e.status === 401);
    }
    const t = jwt.sign({ sub: uid, type: 'access', cv: 0, purpose: 'admin' }, env.jwt.accessSecret, { expiresIn: '15m' });
    assert.throws(() => tokens.verifyAccess(t), e => e.status === 401);
  });
  await check('reset requires current admin password and refuses admin target', async () => {
    await reject(() => admin.resetPassword(actor, uid, { expectedCredentialVersion: 0, currentAdminPassword: 'wrong' }), 401);
    await reject(() => admin.resetPassword(actor, aid, { expectedCredentialVersion: 0, currentAdminPassword: 'bootstrap-only-secret' }), 404);
  });
  const reset = await admin.resetPassword(actor, uid, { expectedCredentialVersion: 0, currentAdminPassword: 'bootstrap-only-secret' });
  await check('reset stores only hash, advances version and revokes local streams', async () => {
    assert.equal(reset.credentialVersion, 1);
    assert.equal(reset.temporaryPassword.length, 32);
    assert.ok(Date.parse(reset.expiresAt) - Date.now() > 86390000);
    assert.notEqual(users.get(uid).passwordHash, reset.temporaryPassword);
    assert.ok(await bcrypt.compare(reset.temporaryPassword, users.get(uid).passwordHash));
    assert.ok(revoked.includes(uid));
    assert.equal(users.get(uid).mustChangePassword, true);
    assert.equal(JSON.stringify(logs).includes(reset.temporaryPassword), false);
    const found = await admin.findUser(actor, ordinary.email.toUpperCase());
    assert.deepEqual(Object.keys(found.user).sort(), ['credentialVersion', 'displayName', 'email', 'id', 'mustChangePassword', 'temporaryPasswordExpiresAt']);
  });
  await check('old app and legacy access/refresh are invalid after reset', async () => {
    for (const t of [old.accessToken, legacy]) await reject(() => middleware(requireAuth, t), 401);
    for (const t of [old.refreshToken, legacyRefresh]) await reject(() => auth.refresh(t), 401);
    await reject(() => auth.login({ email: ordinary.email, password: 'original-password' }), 401);
  });
  const limited = await auth.login({ email: ordinary.email, password: reset.temporaryPassword });
  await check('temporary login yields only limited grant, bounded by temporary expiry', async () => {
    assert.equal(limited.status, 'password_change_required');
    assert.equal(limited.accessToken, undefined); assert.equal(limited.refreshToken, undefined);
    await reject(() => middleware(requireAuth, limited.passwordChangeToken), 401);
    await reject(() => auth.refresh(limited.passwordChangeToken), 401);
    users.get(uid).temporaryPasswordExpiresAt = new Date(Date.now() + 2000);
    const near = await auth.login({ email: ordinary.email, password: reset.temporaryPassword });
    assert.ok(Date.parse(near.expiresAt) <= users.get(uid).temporaryPasswordExpiresAt.getTime());
    users.get(uid).temporaryPasswordExpiresAt = new Date(Date.now() - 1);
    await reject(() => auth.login({ email: ordinary.email, password: reset.temporaryPassword }), 401);
    users.get(uid).temporaryPasswordExpiresAt = new Date(reset.expiresAt);
  });
  const change = { passwordChangeToken: limited.passwordChangeToken, newPassword: 'permanent-password', confirmPassword: 'permanent-password' };
  await check('new password validation includes bcrypt byte boundary, confirmation and temporary reuse', async () => {
    for (const bad of ['short', 'é'.repeat(37), 'abcdefgh\0']) assert.equal(newPasswordSchema.safeParse(bad).success, false);
    assert.equal(newPasswordSchema.safeParse('é'.repeat(36)).success, true);
    await reject(() => auth.completePasswordChange({ ...change, confirmPassword: 'mismatch' }), 400);
    await reject(() => auth.completePasswordChange({ ...change, newPassword: reset.temporaryPassword, confirmPassword: reset.temporaryPassword }), 400);
  });
  await check('completion CAS permits only one concurrent use and issues committed version', async () => {
    const outcomes = await Promise.allSettled([auth.completePasswordChange(change), auth.completePasswordChange(change)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    const session = outcomes.find(x => x.status === 'fulfilled').value;
    assert.equal(tokens.verifyAccess(session.accessToken).credentialVersion, 2);
    await middleware(requireAuth, session.accessToken);
    assert.equal(users.get(uid).mustChangePassword, false);
    assert.equal(users.get(uid).temporaryPasswordExpiresAt, null);
    await reject(() => auth.completePasswordChange(change), 401);
  });
  await check('reset/reset uses observed CAS version; loser cannot return a secret', async () => {
    const input = { expectedCredentialVersion: 2, currentAdminPassword: 'bootstrap-only-secret' };
    const out = await Promise.allSettled([admin.resetPassword(actor, uid, input), admin.resetPassword(actor, uid, input)]);
    assert.equal(out.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(out.filter(x => x.status === 'rejected' && x.reason.status === 409).length, 1);
  });
  await check('reset during password check cannot upgrade an old login snapshot', async () => {
    const u = users.get(uid); u.mustChangePassword = false; u.temporaryPasswordExpiresAt = null;
    u.passwordHash = await bcrypt.hash('race-password', 4);
    const original = bcrypt.compare; let triggered = false;
    bcrypt.compare = async (...args) => {
      const value = await original(...args);
      if (!triggered && args[0] === 'race-password') { triggered = true; u.credentialVersion++; u.mustChangePassword = true; u.temporaryPasswordExpiresAt = new Date(Date.now() + 86400000); }
      return value;
    };
    try { await reject(() => auth.login({ email: u.email, password: 'race-password' }), 401); }
    finally { bcrypt.compare = original; }
  });
  await check('reset after refresh validation only issues the old now-invalid snapshot', async () => {
    const u = users.get(uid); u.mustChangePassword = false; u.temporaryPasswordExpiresAt = null;
    const oldVersion = u.credentialVersion;
    const original = credentials.assertApp;
    credentials.assertApp = async function (...args) { const snapshot = await original.apply(this, args); u.credentialVersion++; return snapshot; };
    let result;
    try { result = await auth.refresh(tokens.signRefresh(uid, oldVersion)); } finally { credentials.assertApp = original; }
    assert.equal(tokens.verifyAccess(result.accessToken).credentialVersion, oldVersion);
    await reject(() => middleware(requireAuth, result.accessToken), 401);
  });
  await check('admin change advances credential version and ends all old admin sessions', async () => {
    assert.deepEqual(await admin.changePassword(actor, { currentPassword: 'bootstrap-only-secret', newPassword: 'admin-new-password', confirmPassword: 'admin-new-password' }), { changed: true });
    await reject(() => middleware(requireAdmin, adminLogin.adminToken), 401);
    await reject(() => admin.login({ email: ADMIN_EMAIL, password: 'bootstrap-only-secret' }), 401);
    await admin.login({ email: ADMIN_EMAIL, password: 'admin-new-password' });
  });
  await check('DB failures are forwarded by wrapped auth middleware', async () => {
    const original = credentials.assertApp;
    credentials.assertApp = async () => { throw new Error('synthetic database failure'); };
    try { await assert.rejects(() => middleware(requireAuth, old.accessToken), /synthetic database failure/); }
    finally { credentials.assertApp = original; }
  });
  await check('bootstrap collision refusal and rerun never overwrite existing hashes', async () => {
    const originalFind = User.findOne, originalCreate = User.create;
    let existing = { email: ADMIN_EMAIL, role: 'user', passwordHash: 'preserve' }, writes = 0;
    User.findOne = () => ({ exec: async () => existing });
    User.create = async input => { writes++; existing = input; return input; };
    try {
      await assert.rejects(() => bootstrapAdmin('operator-input-only'), /collision/);
      assert.equal(writes, 0); assert.equal(existing.passwordHash, 'preserve');
      existing.role = 'admin'; assert.equal(await bootstrapAdmin('different-input'), 'exists');
      assert.equal(writes, 0); assert.equal(existing.passwordHash, 'preserve');
      existing = null; assert.equal(await bootstrapAdmin('operator-input-only'), 'created');
      assert.equal(writes, 1); assert.equal(existing.role, 'admin'); assert.equal(existing.mustChangePassword, false);
      assert.ok(await bcrypt.compare('operator-input-only', existing.passwordHash));
    } finally { User.findOne = originalFind; User.create = originalCreate; }
  });
  await check('bootstrap duplicate insert accepts only a legitimate concurrent admin winner', async () => {
    const originalFind = User.findOne, originalCreate = User.create;
    try {
      for (const winner of [{ email: ADMIN_EMAIL, role: 'admin', passwordHash: 'winner-hash' }, { email: ADMIN_EMAIL, role: 'user', passwordHash: 'user-hash' }, null]) {
        let reads = 0, writes = 0;
        User.findOne = () => ({ exec: async () => ++reads === 1 ? null : winner });
        User.create = async () => { writes++; throw Object.assign(new Error('synthetic duplicate'), { code: 11000 }); };
        if (winner?.role === 'admin') {
          assert.equal(await bootstrapAdmin('losing-input-only'), 'exists');
          assert.equal(winner.passwordHash, 'winner-hash');
        } else await assert.rejects(() => bootstrapAdmin('losing-input-only'), /collision/);
        assert.equal(reads, 2); assert.equal(writes, 1);
      }
      User.findOne = () => ({ exec: async () => null });
      const failure = new Error('synthetic write failure');
      User.create = async () => { throw failure; };
      await assert.rejects(() => bootstrapAdmin('operator-input-only'), error => error === failure);
    } finally { User.findOne = originalFind; User.create = originalCreate; }
  });
  console.log(`PASS ${count} credential/admin unit groups`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
