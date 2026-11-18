'use strict';
// Fault injection against real request/upload code; no network, credentials, browser or provider.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(relative, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Error, Date, Promise, AbortController, DOMException, Headers, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; } }, { filename });
  return mod.exports;
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
function client(fetch, clock = {}) {
  let tokens = { accessToken: 'old', refreshToken: 'refresh' }, generation = 'A';
  const store = { generation: () => generation, isCurrent: expected => expected === generation, get: () => tokens,
    rotate(value, expected) { if (expected !== generation) return false; tokens = value; return true; }, clear() { throw Error('unexpected logout'); } };
  const api = load('lib/apiClient.ts', { './tokenStore': { tokenStore: store } }, { fetch, ...clock });
  return { api, store, switchAccount() { generation = 'B'; } };
}
test('deadline bounds shared refresh wait without aborting refresh used by another request', async () => {
  const refresh = deferred(), calls = [];
  const h = client(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/refresh')) return refresh.promise;
    return init.headers.get('Authorization') === 'Bearer old' ? { status: 401 } : ok('saved');
  });
  const timed = h.api.apiRequest('/timed', { timeoutMs: 15 });
  const survivor = h.api.apiRequest('/survivor');
  await assert.rejects(timed, err => err.code === 'REQUEST_TIMEOUT');
  const refreshCalls = calls.filter(call => call.url.endsWith('/auth/refresh'));
  assert.equal(refreshCalls.length, 1); assert.equal(refreshCalls[0].init.signal, undefined);
  refresh.resolve(ok({ accessToken: 'new', refreshToken: 'new-refresh' }));
  assert.equal(await survivor, 'saved');
  assert.equal(calls.filter(call => call.url === '/api/timed').length, 1, 'expired waiter never retries');
  assert.equal(h.store.get().accessToken, 'new');
});
test('deadline bounds successful and failed JSON body reads, even if transport ignores abort', async () => {
  for (const status of [200, 503]) {
    let signal;
    const h = client(async (_url, init) => { signal = init.signal; return { status, ok: status === 200, json: () => new Promise(() => {}) }; });
    await assert.rejects(h.api.apiRequest('/body', { timeoutMs: 10 }), err => err.code === 'REQUEST_TIMEOUT');
    assert.equal(signal.aborted, true);
  }
});
test('explicit caller abort releases shared refresh waiter but refresh still rotates tokens', async () => {
  const refresh = deferred(), controller = new AbortController();
  const h = client(async url => url.endsWith('/auth/refresh') ? refresh.promise : { status: 401 });
  const request = h.api.apiRequest('/abort', { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(request, { name: 'AbortError' });
  refresh.resolve(ok({ accessToken: 'new', refreshToken: 'new-refresh' })); await tick();
  assert.equal(h.store.get().accessToken, 'new');
});
test('late body result is blocked after access or account change', async () => {
  for (const change of ['access', 'account']) {
    const body = deferred(); const h = client(async () => ({ status: 200, ok: true, json: () => body.promise }));
    const pending = h.api.apiRequest('/body', { timeoutMs: 500 }); await tick();
    if (change === 'access') h.api.advanceAccessEpoch(); else h.switchAccount();
    body.resolve({ data: 'private' });
    await assert.rejects(pending, err => err.code === (change === 'access' ? 'ACCESS_CHANGED' : 'SESSION_CHANGED'));
  }
});
test('upload has one finite budget covering image decode, presign and PUT; timed-out work never continues', async () => {
  for (const stage of ['decode', 'presign', 'put']) {
    const timers = new Map(); let next = 0, presigns = 0, puts = 0;
    const hung = deferred();
    const h = client(async () => ok({}), { setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } });
    const api = load('features/moments/api.ts', {
      '../../lib/apiClient': { ...h.api, apiRequest: async () => { presigns++; return stage === 'presign' ? hung.promise : { uploadUrl: 'https://mock.invalid/upload', imageKey: 'key' }; } },
      '../../lib/image': { compressImageWithSize: async () => stage === 'decode' ? hung.promise : { blob: { type: 'image/jpeg', size: 20 }, width: 10, height: 10 } },
      '../couple/api': {}, '../quests/api': {},
    }, { fetch: async () => { puts++; return stage === 'put' ? hung.promise : { ok: true }; } });
    const request = api.uploadMomentPhoto({}, { localDate: '2026-11-15', sessionId: 'session' }, () => {});
    await tick(); assert.equal(timers.size, 1);
    const rejected = assert.rejects(request, err => err.code === 'REQUEST_TIMEOUT');
    [...timers.values()][0](); await rejected;
    hung.resolve(stage === 'decode' ? { blob: { type: 'image/jpeg', size: 20 }, width: 10, height: 10 } : stage === 'presign' ? { uploadUrl: 'mock', imageKey: 'key' } : { ok: true });
    await tick();
    assert.equal(presigns, stage === 'decode' ? 0 : 1); assert.equal(puts, stage === 'put' ? 1 : 0);
  }
});
