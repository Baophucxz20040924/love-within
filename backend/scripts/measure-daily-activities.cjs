#!/usr/bin/env node
'use strict';

// MOCK/SIMULATED evidence only. Does not load app env, providers, MongoDB, or HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const sourcePath = 'backend/src/services/moment.service.ts';
const NOW = '2026-11-15T10:05:00.000Z';
const DAY = '2026-11-15';
const SESSION = 'fixture-session';
const USER = '000000000000000000000001';
const PARTNER = '000000000000000000000002';
const COUPLE = '000000000000000000000003';
const caption = 'Synthetic fixture only';
const round = value => Math.round(value * 1000) / 1000;

function options(argv) {
  const opts = { updatedRoot: root, baselineRef: 'HEAD', samples: 30, delayMs: 5, repoDelayMs: 1, check: false };
  const flags = { '--updated-root': 'updatedRoot', '--baseline-ref': 'baselineRef', '--samples': 'samples', '--delay-ms': 'delayMs', '--repo-delay-ms': 'repoDelayMs' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') { opts.check = true; continue; }
    if (flag === '--help') {
      console.log('node backend/scripts/measure-daily-activities.cjs [--updated-root PATH] [--baseline-ref REF] [--samples 30] [--delay-ms 5] [--repo-delay-ms 1] [--check]');
      console.log('Offline mock VM comparison; --check uses zero delays, 3 samples, and structural assertions, not timing thresholds.');
      process.exit(0);
    }
    assert.ok(flags[flag] && argv[i + 1] && !argv[i + 1].startsWith('--'), `Unknown/incomplete option: ${flag}`);
    opts[flags[flag]] = argv[++i];
  }
  for (const key of ['samples', 'delayMs', 'repoDelayMs']) opts[key] = Number(opts[key]);
  assert.ok(Number.isInteger(opts.samples) && opts.samples >= 3 && opts.samples <= 1000, 'samples must be an integer in [3,1000]');
  for (const key of ['delayMs', 'repoDelayMs']) assert.ok(Number.isFinite(opts[key]) && opts[key] >= 0 && opts[key] <= 1000, `${key} must be in [0,1000]`);
  assert.match(opts.baselineRef, /^[A-Za-z0-9_./~^+-]+$/, 'Invalid baseline ref');
  assert.ok(!opts.baselineRef.startsWith('-'), 'Baseline ref cannot start with a dash');
  opts.updatedRoot = path.resolve(opts.updatedRoot);
  if (opts.check) Object.assign(opts, { samples: 3, delayMs: 0, repoDelayMs: 0 });
  return opts;
}

class ObjectId {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
  equals(value) { return this.value === String(value); }
}
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}
class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const errors = Object.fromEntries(Object.entries({ notFound: 404, badRequest: 400, forbidden: 403, conflict: 409 })
  .map(([key, status]) => [key, message => new AppError(status, key, message)]));
const couple = { _id: new ObjectId(COUPLE), memberIds: [new ObjectId(USER), new ObjectId(PARTNER)], timezone: 'UTC', createdAt: new Date('2026-01-01T00:00:00Z') };
const input = { localDate: DAY, sessionId: SESSION, key: `couples/${COUPLE}/moments/${DAY}/${SESSION}/${USER}/fixture.jpg`, width: 800, height: 600, caption };
function photo(userId) {
  return { userId: new ObjectId(userId), key: `fixture/${userId}.jpg`, width: 800, height: 600, caption, postedAt: new Date(NOW), lateMin: 0 };
}
function day(posts) {
  return { _id: new ObjectId('000000000000000000000004'), coupleId: couple._id, localDate: DAY, scheduleVersion: 3, timezone: 'UTC',
    sessions: [{ id: SESSION, promptAt: new Date('2026-11-15T10:00:00Z'), rewardEndsAt: new Date('2026-11-15T10:30:00Z'), closesAt: new Date('2026-11-16T00:00:00Z'), notifiedAt: null, storyId: null, posts }] };
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { p50: at(0.5), p95: at(0.95), min: round(sorted[0]), max: round(sorted.at(-1)) };
}
const hash = text => createHash('sha256').update(text).digest('hex');
const delay = ms => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

function compiler(updatedRoot) {
  // Reuse an already-installed dev compiler. No install, npm, env file, or app require.
  let filename;
  try { filename = require.resolve('typescript', { paths: [path.join(root, 'backend'), path.join(updatedRoot, 'backend')] }); }
  catch { throw new Error('Existing TypeScript compiler not found. Point --updated-root at a checkout with its existing backend/node_modules; this script never installs dependencies.'); }
  return require(filename);
}
function compile(ts, source) {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  return result.outputText;
}

function harness(code, opts) {
  let doc;
  let calls;
  let steps;
  let sequence;
  let logs;
  let forbidden = new Set();
  const step = (name, kind, fn) => async (...args) => {
    calls[name] = (calls[name] || 0) + 1;
    sequence.push(name);
    if (forbidden.has(name)) throw new Error(`Injected failure: ${name}`);
    const start = performance.now();
    try {
      await delay(kind === 'effect' ? opts.delayMs : opts.repoDelayMs);
      return fn ? await fn(...args) : undefined;
    } finally { (steps[name] ||= []).push(performance.now() - start); }
  };
  const repository = {
    findDay: step('repo.moment.findDay', 'repo', () => doc),
    addPost: step('repo.moment.addPost', 'repo', (_couple, _day, _session, post) => {
      assert.ok(!doc.sessions[0].posts.some(p => p.userId.equals(post.userId)));
      doc.sessions[0].posts.push({ ...post, postedAt: new Date(NOW), lateMin: 0 });
      return doc;
    }),
  };
  const storage = {
    headObject: step('storage.headObject', 'repo', () => ({ size: 2048 })),
    getDownloadUrl: step('storage.getDownloadUrl', 'effect', () => ({ url: 'https://fixture.invalid/photo.jpg?signature=synthetic' })),
  };
  const mocked = {
    'node:perf_hooks': { performance },
    'node:crypto': { randomInt: () => 0, randomUUID: () => SESSION },
    mongoose: { Types: { ObjectId } },
    '../config/env.js': { env: { s3: { maxUploadBytes: 10_000_000 } } },
    '../models/DuoMoment.js': { LEGACY_MOMENT_ON_TIME_MIN: 2, MOMENT_ON_TIME_MIN: 30, MOMENT_WINDOW_FROM: '08:00', MOMENT_WINDOW_TO: '22:00', MOMENT_SCHEDULE_VERSION: 3 },
    '../integrations/index.js': { getStorage: () => storage },
    '../repositories/moment.repository.js': { momentRepository: repository },
    '../repositories/story.repository.js': { storyRepository: { aliveIds: step('repo.story.aliveIds', 'repo', () => new Set()) } },
    '../repositories/user.repository.js': { userRepository: {} },
    './realtimeAudience.service.js': { realtimeAudience: { couple: step('effect.realtime', 'effect') } },
    './notification.service.js': { notificationService: { toPartner: step('effect.notification', 'effect') } },
    './quest.service.js': { DUO_MOMENT_QUEST_KEY: 'duo_moment', questService: { refresh: step('effect.quest', 'effect') } },
    './rewardPolicy.service.js': { rewardPolicyService: { ensure: step('service.rewardPolicy.ensure', 'repo', () => ({ version: 1 })) } },
    './dailyReward.service.js': { dailyRewardService: { getMomentRewardViews: step('service.dailyReward.getMomentRewardViews', 'repo', (_couple, docs) => {
      // Deliberately synthetic: this is not a benchmark of reward internals or their queries.
      return new Map(docs.map(d => [d.localDate, { status: 'pending', coin: 20, synthetic: true }]));
    }) } },
    './story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg' }, storyService: {} },
    '../utils/date.js': {
      getLocalDate: date => date.toISOString().slice(0, 10),
      addDays: (date, amount) => new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10),
      formatDayVi: date => date,
      zonedTimeToUtc: (date, time) => new Date(`${date}T${time}:00Z`),
    },
    '../utils/errors.js': { AppError, Errors: errors },
    '../utils/logger.js': { logger: { info: (message, fields) => logs.push({ message, fields }), warn() {}, error() {} } },
  };
  const mod = { exports: {} };
  function requireMock(name) {
    assert.ok(Object.hasOwn(mocked, name), `Unmocked import blocked: ${name}`);
    return mocked[name];
  }
  // No process, fetch, timers, real require, env reader, socket, or provider in the VM.
  const loadStart = performance.now();
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: requireMock, Date: FixedDate }, { filename: 'mock-moment.service.cjs', timeout: 2000 });
  const loadMs = performance.now() - loadStart;
  return {
    service: mod.exports.momentService,
    loadMs,
    reset(scenario, fail = []) {
      doc = day(scenario === 'post.first' ? [] : [photo(PARTNER)]);
      calls = {}; steps = {}; sequence = []; logs = []; forbidden = new Set(fail);
    },
    result() { return { calls, steps, sequence, logs, posts: doc.sessions[0].posts }; },
  };
}

const forbiddenPost = ['storage.getDownloadUrl', 'effect.quest', 'effect.notification', 'effect.realtime', 'repo.story.aliveIds', 'service.dailyReward.getMomentRewardViews'];
function verifyReceipt(dto) {
  assert.deepEqual(Object.keys(dto).sort(), ['localDate', 'postedAt', 'saved', 'sessionId']);
  assert.equal(dto.saved, true);
  assert.equal(dto.localDate, DAY);
  assert.equal(dto.sessionId, SESSION);
  assert.equal(dto.postedAt, NOW);
}
async function exercise(h, variant, scenario) {
  const receipt = await h.service.post(couple, USER, input);
  if (variant === 'updated') {
    verifyReceipt(receipt);
    const state = h.result();
    assert.equal(state.calls['service.rewardPolicy.ensure'], 1, 'Policy activation must remain in commit path');
    for (const name of forbiddenPost) assert.equal(state.calls[name] || 0, 0, `${name} must not run before receipt`);
    assert.ok(state.sequence.indexOf('service.rewardPolicy.ensure') < state.sequence.indexOf('repo.moment.addPost'));
    for (const log of state.logs) for (const [key, value] of Object.entries(log.fields || {})) {
      assert.ok(['lateMin', 'headMs', 'commitMs', 'totalMs'].includes(key), `Unexpected post log field: ${key}`);
      assert.ok(typeof value === 'number' && Number.isFinite(value), `Post log ${key} must be numeric`);
    }
  } else {
    assert.equal(receipt.sessions[0].state, scenario === 'post.first' ? 'posted' : 'both');
    for (const name of ['effect.quest', 'effect.notification', 'effect.realtime']) assert.equal(h.result().calls[name], 1);
  }
  if (scenario === 'post.second.with-view' && variant === 'updated') {
    const view = await h.service.today(couple, USER);
    assert.equal(view.sessions[0].state, 'both');
    assert.ok(view.sessions[0].mine.url && view.sessions[0].partner.photo.url);
    assert.equal(h.result().calls['service.dailyReward.getMomentRewardViews'], 1, 'View should use batched reward view API');
    return { payloads: [receipt, view], receipt };
  }
  return { payloads: [receipt], receipt };
}

async function measure(code, variant, scenario, phase, opts) {
  const samples = [];
  let warm;
  if (phase === 'warm') {
    warm = harness(code, opts);
    for (let i = 0; i < 5; i++) { warm.reset(scenario); await exercise(warm, variant, scenario); }
  }
  for (let i = 0; i < opts.samples; i++) {
    const h = warm || harness(code, opts);
    h.reset(scenario);
    const start = performance.now();
    const output = await exercise(h, variant, scenario);
    const serviceMs = performance.now() - start;
    const serializationStart = performance.now();
    const dtoBytes = output.payloads.reduce((sum, dto) => sum + Buffer.byteLength(JSON.stringify(dto), 'utf8'), 0);
    const serializationMs = performance.now() - serializationStart;
    const state = h.result();
    assert.equal(state.calls['repo.moment.addPost'], 1);
    assert.equal(state.calls['repo.moment.findDay'], variant === 'updated' && scenario === 'post.second.with-view' ? 2 : 1);
    assert.equal(state.calls['storage.headObject'], 1);
    const expectedSigns = variant === 'baseline' || scenario === 'post.second.with-view' ? (scenario === 'post.first' ? 1 : 2) : 0;
    assert.equal(state.calls['storage.getDownloadUrl'] || 0, expectedSigns);
    samples.push({ serviceMs, serializationMs, dtoBytes, loadMs: h.loadMs, ...state });
  }
  const callNames = [...new Set(samples.flatMap(s => Object.keys(s.calls)))].sort();
  const callsPerOperation = {};
  const stepMs = {};
  for (const name of callNames) {
    const counts = samples.map(s => s.calls[name] || 0);
    callsPerOperation[name] = { min: Math.min(...counts), max: Math.max(...counts) };
    stepMs[name] = stats(samples.flatMap(s => s.steps[name] || []));
  }
  return { variant, scenario, phase, samples: opts.samples,
    serviceMs: stats(samples.map(s => s.serviceMs)), serializationMs: stats(samples.map(s => s.serializationMs)),
    dtoBytes: stats(samples.map(s => s.dtoBytes)),
    freshVmLoadMs: phase === 'cold' ? stats(samples.map(s => s.loadMs)) : null,
    callsPerOperation, stepMs };
}

async function checks(compiled, opts) {
  const h = harness(compiled.updated, { ...opts, delayMs: 0, repoDelayMs: 0 });
  h.reset('post.second', forbiddenPost);
  await exercise(h, 'updated', 'post.second');
  const baseline = harness(compiled.baseline, { ...opts, delayMs: 0, repoDelayMs: 0 });
  baseline.reset('post.second', ['effect.realtime']);
  await assert.rejects(exercise(baseline, 'baseline', 'post.second'), /Injected failure: effect.realtime/);
  assert.equal(baseline.result().posts.length, 2, 'Baseline failure is after the simulated source commit');
  assert.throws(() => harness('require("node:net");', opts), /Unmocked import blocked/);
  assert.throws(() => harness('require("..\/config\/unmocked-env.js");', opts), /Unmocked import blocked/);
}

async function main() {
  const opts = options(process.argv.slice(2));
  const baselineCommit = execFileSync('git', ['rev-parse', '--verify', `${opts.baselineRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const source = {
    baseline: execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { cwd: root, encoding: 'utf8' }),
    updated: fs.readFileSync(path.join(opts.updatedRoot, sourcePath), 'utf8'),
  };
  const ts = compiler(opts.updatedRoot);
  const compiled = Object.fromEntries(Object.entries(source).map(([name, text]) => [name, compile(ts, text)]));
  await checks(compiled, opts);
  const rows = [];
  for (const scenario of ['post.first', 'post.second', 'post.second.with-view']) {
    for (const phase of ['cold', 'warm']) {
      // Alternate ordering across phases to avoid always giving one variant first run.
      for (const variant of phase === 'cold' ? ['baseline', 'updated'] : ['updated', 'baseline']) {
        rows.push(await measure(compiled[variant], variant, scenario, phase, opts));
      }
    }
  }
  console.log(JSON.stringify({
    kind: 'MOCK_SIMULATED_NOT_REAL_DB_HTTP_OR_IPHONE', check: opts.check, assertions: 'passed',
    runtime: { node: process.version, platform: process.platform, arch: process.arch, typescript: ts.version },
    source: { baselineCommit, baselineSha256: hash(source.baseline), updatedSha256: hash(source.updated) },
    settings: { samplesPerRow: opts.samples, warmups: 5, effectDelayMs: opts.delayMs, repoStorageHeadAndRewardBoundaryDelayMs: opts.repoDelayMs },
    definitions: {
      cold: 'Fresh VM/module per sample; fixture reset. VM load reported separately, transpilation excluded. Not a cold DB/HTTP/provider/device.',
      warm: 'One VM/module reused after 5 warmups, fixture reset before every call. No fabricated signing, policy, or database cache.',
      serviceMs: 'Awaited mocked service journey including structural assertions, excluding VM load and JSON serialization.',
      dtoBytes: 'UTF-8 JSON of returned payloads only; no HTTP envelope/compression/headers. with-view sums commit receipt + refresh for updated, one full response for baseline; synthetic reward-view shape.',
      calls: 'Mock boundary invocations, NOT measured SQL/Mongo queries; reward/quest/notification/wallet internals excluded.',
      stepMs: 'Per invocation elapsed time at mocked async boundaries; overlaps must not be summed into request latency.',
    },
    excluded: ['checkin', 'ledger', 'real reward-policy and reward-view internals', 'background effects/reward recovery', 'DB/CAS/index correctness', 'HTTP/auth/upload/compression', 'network/providers', 'iPhone/UI responsiveness'],
    rows,
  }, null, 2));
}
main().catch(error => { console.error(`Mock performance evidence failed: ${error.message}`); process.exitCode = 1; });
