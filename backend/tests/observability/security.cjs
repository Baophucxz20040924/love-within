// Isolated source-level unit checks: no dotenv, sockets, database, providers, or child processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../src');
function load(file, mocks = {}) {
  const filename = path.join(root, file);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('node:')) return require(id);
    throw new Error('Unexpected import in isolated unit: ' + id);
  };
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(localRequire, module, module.exports);
  return module.exports;
}
let passed = 0;
async function check(name, work) { await work(); passed++; console.log('PASS ' + name); }
async function main() {
  const correlation = load('middleware/requestCorrelation.ts');
  await check('server correlation is unique and survives concurrent async work', async () => {
    const seen = await Promise.all([1, 2].map(() => new Promise((resolve) => {
      const res = { locals: {}, setHeader(key, value) { this[key] = value; } };
      correlation.requestCorrelation({ headers: { 'x-request-id': 'untrusted' } }, res, () => {
        setImmediate(() => { assert.equal(correlation.currentRequestId(), res.locals.requestId); resolve(res['X-Request-ID']); });
      });
    })));
    assert.notEqual(seen[0], seen[1]); assert.match(seen[0], /^[a-f\d-]{36}$/i);
    assert.equal(correlation.currentRequestId(), undefined);
  });
  await check('logger redacts raw IDs and private metadata while retaining generated correlation', async () => {
    const lines = [];
    const log = load('utils/logger.ts', { '../config/env.js': { isProd: true }, '../middleware/requestCorrelation.js': correlation }).logger;
    const old = console.error;
    console.error = (line) => lines.push(line);
    try {
      correlation.requestCorrelation({}, { locals: {}, setHeader() {} }, () => log.error('Synthetic event', {
        userId: 'RAW_USER_CANARY', token: 'TOKEN_CANARY', note: 'NOTE_CANARY', email: 'CANARY@example.test',
        routeTemplate: '/:id/comments', section: 'savings', durationMs: 12,
      }));
    } finally { console.error = old; }
    assert.equal(lines.length, 1);
    for (const canary of ['RAW_USER_CANARY', 'TOKEN_CANARY', 'NOTE_CANARY', 'CANARY@example.test']) assert.ok(!lines[0].includes(canary));
    const entry = JSON.parse(lines[0]); assert.ok(entry.requestId); assert.equal(entry.routeTemplate, '/:id/comments');
  });
  await check('response error adds the server request ID without changing stable code', () => {
    const response = load('utils/response.ts');
    const res = { locals: { requestId: 'server-id' }, status(n) { this.statusCode = n; return this; }, json(value) { return value; } };
    assert.deepEqual(response.fail(res, 400, 'BAD_REQUEST', 'Invalid'), { error: { code: 'BAD_REQUEST', message: 'Invalid', requestId: 'server-id' } });
  });
  await check('HTTP metrics distinguish friend routers and retain declared length/abort semantics', () => {
    const counts = [];
    const metrics = load('middleware/requestMetrics.ts', { '../utils/monitor.js': { countRequest: (status) => counts.push(status) } });
    function response(area, length, aborted = false) {
      const req = { method: 'GET', baseUrl: '', route: { path: '/:id' } };
      const res = new EventEmitter(); Object.assign(res, { locals: {}, statusCode: 200, writableFinished: !aborted, getHeader: () => length });
      metrics.requestMetrics(req, res, () => {}); metrics.metricArea(area)(req, res, () => {});
      res.emit(aborted ? 'close' : 'finish'); res.emit('close');
    }
    response('friends.events', '42'); response('friends.stories', undefined); response('friends.outings', undefined, true);
    const snapshot = metrics.requestMetricsSnapshot();
    assert.equal(snapshot.inFlight, 0); assert.equal(snapshot.aborted, 1); assert.equal(counts.length, 2);
    assert.equal(snapshot.routes['GET friends.events:/:id 2xx'].declaredBytes, 42);
    assert.equal(snapshot.routes['GET friends.stories:/:id 2xx'].unknownLength, 1);
    assert.match(snapshot.byteMeasurement, /declared Content-Length/);
    for (let i = 0; i < 400; i++) {
      const req = { method: 'GET', baseUrl: '/api/friends', route: { path: '/static' + i } };
      const res = new EventEmitter(); Object.assign(res, { locals: {}, statusCode: 200, writableFinished: true, getHeader: () => undefined });
      metrics.requestMetrics(req, res, () => {}); res.emit('finish');
    }
    assert.ok(Object.keys(metrics.requestMetricsSnapshot().routes).length <= 256);
  });
  const monitor = load('utils/monitor.ts', {
    mongoose: { default: { connection: { readyState: 1 } } },
    '../config/env.js': { env: { ops: { memWarnMb: 1024 } } }, './logger.js': { logger: { warn() {} } },
  });
  await check('operation timing labels reject runtime untrusted strings and copy buckets', () => {
    monitor.observePulseSection('question', 'empty', 12); monitor.observePulseSection('RAW_ID_CANARY', 'ok', 2);
    monitor.observeSavingsWrite('held', 'recovery_required', 30);
    const snapshot = monitor.operationMetricsSnapshot();
    assert.equal(snapshot.timings['pulse.question.empty'].count, 1); assert.equal(Object.keys(snapshot.timings).length, 2);
    snapshot.timings['pulse.question.empty'].buckets[0] = 100;
    assert.equal(monitor.operationMetricsSnapshot().timings['pulse.question.empty'].buckets[0], 0);
  });
  await check('pending badge and request visibility queries exclude both-way blocked IDs', async () => {
    const queries = [];
    const repository = load('repositories/friendship.repository.ts', {
      mongoose: { Types: {} }, '../models/FriendSafety.js': {},
      '../models/Friendship.js': { Friendship: {
        countDocuments(query) { queries.push(query); return { exec: async () => 0 }; },
        find(query) { queries.push(query); return { select() { return this; }, lean() { return this; }, exec: async () => [] }; },
      } },
    }).friendshipRepository;
    await repository.countIncomingPending('fixture-user', new Set(['blocked-user']));
    await repository.pendingIncomingIds('fixture-user', ['request-id'], new Set(['blocked-user']));
    assert.equal(queries.length, 2);
    for (const query of queries) { assert.deepEqual(query.requesterId, { $nin: ['blocked-user'] }); assert.equal(query.recipientId, 'fixture-user'); }
  });
  console.log(`---- ${passed}/${passed} passed, failures: 0 ----`);
}
main().catch((err) => { console.error('FAIL isolated security observability units:', err); process.exitCode = 1; });
