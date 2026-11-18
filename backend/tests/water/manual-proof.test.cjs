'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function dependency(name) {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    try { return require(require.resolve(name, { paths: [dir, path.join(dir, 'backend')] })); } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
    if (path.dirname(dir) === dir) throw Error(`Installed ${name} not found`);
  }
}
const ts = dependency('typescript'), mongoose = dependency('mongoose'), { z } = dependency('zod');
const { Types } = mongoose;
function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, console, require(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'mongoose') return mongoose;
    if (name.startsWith('node:')) return require(name);
    throw Error(`Unmocked ${name}`);
  } }, { filename });
  return module.exports;
}
const errors = load('utils/errors.ts');
const uid = new Types.ObjectId(), partner = new Types.ObjectId(), cid = new Types.ObjectId();
const couple = { _id: cid, memberIds: [uid, partner], timezone: 'UTC' };
const suffix = '2026-11-18/12345678-1234-4234-8234-123456789abc';
const key = `couples/${cid}/water-proofs/${uid}/${suffix}.jpg`;
const cap = 5 * 1024 * 1024;
const jpeg = Buffer.from('ffd8ffe000104a464946000101', 'hex');
function setup() {
  const calls = [], objects = new Map([[key, { size: jpeg.length, mimeType: 'image/jpeg', bytes: jpeg }]]);
  let log;
  const storage = {
    getUploadUrl: async input => { calls.push(['upload', input]); return { uploadUrl: 'private-put', expiresIn: 300 }; },
    headObject: async key => { calls.push(['head', key]); return objects.get(key) ?? null; },
    getObjectPrefix: async (key, cap) => { calls.push(['prefix', key, cap]); return objects.get(key).bytes; },
    getObject: async () => assert.fail('Manual proofs must not download entire object'),
    deleteObject: async () => assert.fail('Do not delete possibly attached proof'),
    getDownloadUrl: async key => { calls.push(['sign', key]); return { url: 'private-get', expiresIn: 300 }; },
  };
  const repo = {
    createLog: async input => { calls.push(['create', input]); log = { _id: new Types.ObjectId(), createdAt: new Date(), ...input }; return log; },
    listLogs: async () => log ? [log] : [],
    listPending: async () => log?.status === 'pending' ? [log] : [],
    findLog: async (coupleId, id) => coupleId.equals(cid) && log?._id.toString() === id ? log : null,
    review: async (_couple, _log, status, reviewer) => { log.status = status; log.reviewedBy = reviewer; return log; },
    getDaily: async () => null,
    addToDaily: async (...args) => { calls.push(['daily', ...args]); return { totalMl: 250, goalMet: false }; },
  };
  const service = load('services/water.service.ts', {
    '../config/env.js': { env: { s3: { maxUploadBytes: cap } } },
    '../integrations/index.js': { getStorage: () => storage, getVision: () => assert.fail('Manual evidence never invokes vision') },
    '../integrations/ai/WaterVisionProvider.js': { WaterVisionError: class extends Error {} },
    '../repositories/water.repository.js': { waterRepository: repo },
    '../repositories/coupleSettings.repository.js': { coupleSettingsRepository: { getOrCreate: async () => ({ waterGoalMl: 2000 }) } },
    '../repositories/proposal.repository.js': { proposalRepository: { findPendingByKind: async () => null } },
    '../repositories/user.repository.js': { userRepository: { findDisplayNames: async () => new Map() } },
    './quest.service.js': { questService: { refresh: async () => calls.push(['quest']) } },
    './notification.service.js': { notificationService: { toPartner: async () => calls.push(['notify']) } },
    './realtimeAudience.service.js': { realtimeAudience: { couple: async () => {} } },
    '../utils/date.js': { getLocalDate: () => '2026-11-18' },
    '../utils/errors.js': errors,
    '../utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
  });
  return { ...service, calls, objects, get log() { return log; } };
}

test('signing defaults preserve AI; manual purpose is member-scoped and disjoint', async () => {
  const { waterService: s, calls } = setup();
  const proof = await s.createUploadUrl(couple, String(uid), 'image/jpeg', 25, 'manual_proof');
  assert.match(proof.imageKey, new RegExp(`^couples/${cid}/water-proofs/${uid}/2026-11-18/[a-f0-9-]+\\.jpg$`));
  const ai = await s.createUploadUrl(couple, String(uid), 'image/heic', 25);
  assert.match(ai.imageKey, new RegExp(`^couples/${cid}/water/`));
  for (const size of [0, -1, 1.2, Infinity, cap + 1]) await assert.rejects(s.createUploadUrl(couple, String(uid), 'image/jpeg', size, 'manual_proof'));
  for (const mime of ['image/heic', 'video/mp4', 'image/svg+xml', '__proto__']) await assert.rejects(s.createUploadUrl(couple, String(uid), mime, 25, 'manual_proof'));
  await assert.rejects(s.createUploadUrl(couple, String(new Types.ObjectId()), 'image/jpeg', 25, 'manual_proof'));
  await assert.rejects(s.createUploadUrl(couple, String(uid), 'image/jpeg', 25, 'foreign'));
  assert.equal(calls.filter(c => c[0] === 'upload').length, 2);
});

test('manual with or without photo remains pending/manual/null AI, no reward before review', async () => {
  for (const imageKey of [undefined, key]) {
    const x = setup(); const r = await x.waterService.submitManual(couple, String(uid), 250, imageKey);
    assert.equal(r.status, 'pending'); assert.equal(r.totalMl, 0); assert.equal(r.pendingMl, 250);
    assert.equal(x.log.source, 'manual'); assert.equal(x.log.aiRaw, null); assert.equal(x.log.imageKey, imageKey ?? null);
    assert.equal(x.calls.some(c => c[0] === 'daily' || c[0] === 'quest'), false);
    assert.equal(x.calls.filter(c => c[0] === 'head').length, imageKey ? 1 : 0);
    const today = await x.waterService.today(couple, String(uid));
    assert.equal(today.logs[0].hasImage, Boolean(imageKey)); assert.equal('imageKey' in today.logs[0], false);
    if (imageKey) assert.equal(x.calls.find(c => c[0] === 'prefix')[2], x.MANUAL_PROOF_PREFIX_BYTES);
  }
});

test('manual refuses foreign, other-member, AI, malformed and unsupported keys before storage', async () => {
  const x = setup();
  const bad = [key.replace(String(cid), String(new Types.ObjectId())), key.replace(String(uid), String(partner)),
    `couples/${cid}/water/${suffix}.jpg`, key.replace('.jpg', '.heic'), key + '/extra', key + '?x', key + '\n', key + '\r\n', key.replace('2026-11-18', '2026-02-31'),
    key.replace('2026-11-18', '../2026-11-18'), key.replace('4234', '1234'), '', key.replace('.jpg', '.JPG')];
  for (const value of bad) await assert.rejects(x.waterService.submitManual(couple, String(uid), 250, value));
  assert.equal(x.calls.length, 0);
  await assert.rejects(x.waterService.submitFromPhoto(couple, String(uid), key));
});

test('HEAD rejects missing/empty/oversize/noninteger/wrong MIME, bounded read rejects signature mismatch', async () => {
  for (const object of [null, { size: 0 }, { size: -1 }, { size: cap + 1 }, { size: 1.5 }, { mimeType: 'video/mp4' }, { mimeType: 'image/png' },
    { bytes: Buffer.from('not an image') }, { bytes: Buffer.alloc(33) }, { size: 3, bytes: jpeg }]) {
    const x = setup(); if (object === null) x.objects.delete(key); else x.objects.set(key, { size: jpeg.length, mimeType: 'image/jpeg', bytes: jpeg, ...object });
    await assert.rejects(x.waterService.submitManual(couple, String(uid), 250, key));
    assert.equal(x.calls.some(c => c[0] === 'create'), false);
  }
});

test('PNG and WebP signatures must match their extensions and HEAD MIME', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const webp = Buffer.from('52494646080000005745425056503820', 'hex');
  for (const [ext, mime, bytes] of [['png', 'image/png', png], ['webp', 'image/webp', webp]]) {
    const x = setup(), k = key.replace('.jpg', `.${ext}`);
    x.objects.set(k, { size: bytes.length, mimeType: mime, bytes });
    await x.waterService.submitManual(couple, String(uid), 250, k);
    assert.equal(x.log.imageKey, k);
  }
});

test('reviewer can view/approve/reject, owner can withdraw but not self-approve; foreign image log never signs', async () => {
  for (const [reviewer, decision] of [[partner, 'approve'], [partner, 'reject'], [uid, 'reject']]) {
    const x = setup(); await x.waterService.submitManual(couple, String(uid), 250, key);
    const id = String(x.log._id);
    assert.equal((await x.waterService.imageUrl(couple, id)).expiresIn, 300);
    await assert.rejects(x.waterService.review(couple, String(uid), id, 'approve'));
    const r = await x.waterService.review(couple, String(reviewer), id, decision);
    assert.equal(r.status, decision === 'approve' ? 'approved' : 'rejected');
    assert.equal(x.calls.filter(c => c[0] === 'daily').length, decision === 'approve' ? 1 : 0);
    await assert.rejects(x.waterService.review(couple, String(partner), id, decision));
    await assert.rejects(x.waterService.imageUrl({ ...couple, _id: new Types.ObjectId() }, id));
    x.log.status = undefined;
    assert.equal((await x.waterService.today(couple, String(uid))).logs[0].status, 'approved');
  }
});

test('route schemas accept optional proof, default AI purpose and forward member plus imageKey', async () => {
  const registered = [], calls = [];
  const router = { use() {}, get(...args) { registered.push(['get', ...args]); }, post(...args) { registered.push(['post', ...args]); } };
  load('routes/water.routes.ts', {
    express: { Router: () => router }, zod: { z },
    '../middleware/errorHandler.js': { asyncHandler: fn => fn },
    '../middleware/auth.js': { requireAuth() {} }, '../middleware/coupleContext.js': { requireCouple() {} },
    '../middleware/validate.js': { validate: schemas => ({ schemas }) },
    '../middleware/rateLimit.js': { uploadUrlLimiter() {}, waterManualLimiter() {}, waterPhotoLimiter() {} },
    '../services/water.service.js': { ALLOWED_IMAGE_TYPES: { 'image/jpeg': 'jpg' }, MAX_MANUAL_ML: 3000, waterService: {
      submitManual: async (...args) => calls.push(['manual', ...args]), createUploadUrl: async (...args) => calls.push(['upload', ...args]),
    } },
    '../services/proposal.service.js': { proposalService: {} },
    '../services/proposalHandlers/waterGoal.handler.js': { waterGoalPayloadSchema: z.object({}) },
    '../utils/response.js': { ok() {} },
  });
  const manual = registered.find(r => r[1] === '/manual'), upload = registered.find(r => r[1] === '/upload-url');
  const schema = r => r.find(v => v?.schemas)?.schemas.body;
  assert.equal(schema(manual).parse({ amountMl: 250, imageKey: key }).imageKey, key);
  assert.equal(schema(manual).safeParse({ amountMl: 250 }).success, true);
  for (const bad of [{ amountMl: 9 }, { amountMl: 3001 }, { amountMl: 12.5 }, { amountMl: 250, imageKey: '' }, { amountMl: 250, imageKey: null }]) assert.equal(schema(manual).safeParse(bad).success, false);
  assert.equal(schema(upload).parse({ mimeType: 'image/jpeg', sizeBytes: 10 }).purpose, 'ai');
  assert.equal(schema(upload).safeParse({ mimeType: 'image/jpeg', sizeBytes: 10, purpose: 'anything' }).success, false);
  await manual.at(-1)({ couple, userId: String(uid), body: { amountMl: 250, imageKey: key } }, {});
  assert.equal(calls[0][4], key);
  await upload.at(-1)({ couple, userId: String(uid), body: { mimeType: 'image/jpeg', sizeBytes: 10, purpose: 'manual_proof' } }, {});
  assert.equal(calls[1][2], String(uid)); assert.equal(calls[1][5], 'manual_proof');
});
