'use strict';
// Actual RealtimeSync component, isolated hook/event harness; no network/browser dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
const filename = path.resolve(__dirname, '../../src/features/realtime/RealtimeSync.tsx');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture({ locked = false, eligible = true, authenticated = true } = {}) {
  const effects = [], cleanups = [], listeners = new Map(), transitions = [], streams = [], timers = new Map();
  const identity = deferred(), scope = deferred();
  const calls = { identity: 0, scope: 0, epochs: 0, revokes: 0 };
  const document = { visibilityState: eligible ? 'visible' : 'hidden', addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const mocks = {
    react: { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useLayoutEffect: effect => effects.push(effect), useSyncExternalStore: (_subscribe, get) => get() },
    '@tanstack/react-query': { useQueryClient: () => ({}) },
    '../appLock/store': { subscribeAppLock() {}, isAppLocked: () => locked },
    '../auth/AuthContext': { useAuth: () => ({ isAuthenticated: authenticated, me: authenticated ? { user: { id: 'synthetic-user' } } : null, space: 'couple', refreshMe() {}, revokeMe() {}, verifyMe: () => { calls.identity++; return identity.promise; } }) },
    '../../lib/tokenStore': { tokenStore: { generation: () => 'synthetic', isCurrent: () => true, get: () => authenticated ? {} : null } },
    '../../lib/apiClient': { advanceAccessEpoch() { calls.epochs++; }, withRequestDeadline: (_ms, signal, run) => run(signal) },
    './verification': { setVerification: (value, retry) => transitions.push({ value, retry }) },
    './invalidation': { DomainBatch: class { add() {} clear() {} flush() {} }, invalidateDomains() {}, needsMe() { return false; }, revokeDomains() {}, scopeDomains() { return []; }, verifyScope: () => { calls.scope++; return scope.promise; } },
    './stream': { RealtimeStream: class { constructor(_space, event, disconnected) { this.event = event; this.disconnected = disconnected; this.stopped = false; streams.push(this); } start() {} stop() { this.stopped = true; } } },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, document, window, AbortController, navigator: { onLine: true },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name]; } }, { filename });
  module.exports.RealtimeSync();
  effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  return { calls, identity, scope, streams, document, listeners, transitions, timers, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

test('initial and ready coalesce before fencing; genuine access supersedes', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.streams[0].event({ type: 'ready', domains: [] });
  assert.equal(f.calls.identity, 1); assert.equal(f.calls.scope, 1); assert.equal(f.calls.epochs, 1);
  f.streams[0].event({ type: 'access', domains: ['account'] });
  assert.equal(f.calls.identity, 2); assert.equal(f.calls.scope, 2);
  // revokeDomains owns the new epoch; reconcile must not advance it a second time.
  assert.equal(f.calls.epochs, 1);
  f.identity.resolve(true); f.scope.resolve(true); await new Promise(setImmediate);
  assert.equal(f.transitions.filter(t => t.value === 'clear').length, 1);
  f.unmount();
});

test('dirty burst during verification gets one trailing scope pass, not another auth epoch', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.streams[0].event({ type: 'dirty', domains: ['stories'] });
  f.identity.resolve(true); f.scope.resolve(true); await new Promise(setImmediate);
  assert.equal(f.calls.scope, 2); assert.equal(f.calls.identity, 1); assert.equal(f.calls.epochs, 1);
  assert.equal(f.transitions.at(-1).value, 'clear'); f.unmount();
});

for (const scenario of [{ locked: true }, { eligible: false }, { authenticated: false }]) {
  test(`teardown releases verification for early branch ${JSON.stringify(scenario)}`, () => {
    const f = fixture(scenario);
    const staleListener = f.listeners.get('visibilitychange');
    f.unmount();
    assert.equal(f.transitions.at(-1).value, 'clear');
    assert.equal(f.listeners.size, 0);
    const count = f.transitions.length;
    f.document.visibilityState = 'hidden'; staleListener();
    assert.equal(f.transitions.length, count, 'queued obsolete lifecycle callback cannot re-mask admin');
    assert.equal(f.streams.length, 0);
  });
}

for (const outcome of ['success', 'failure', 'rejection']) {
  test(`unmount fences late verification ${outcome}, stream events and disconnects`, async () => {
    const f = fixture();
    assert.equal(f.transitions.at(-1).value, 'checking');
    f.unmount();
    assert.equal(f.transitions.at(-1).value, 'clear');
    assert.equal(f.streams[0].stopped, true);
    const count = f.transitions.length;
    if (outcome === 'rejection') f.identity.reject(new Error('synthetic failure'));
    else f.identity.resolve(outcome === 'success');
    f.scope.resolve(outcome === 'success');
    await new Promise(setImmediate);
    f.streams[0].event({ type: 'ready', domains: [] });
    f.streams[0].event({ type: 'access', domains: ['account'] });
    f.streams[0].disconnected();
    assert.equal(f.transitions.length, count);
    assert.equal(f.timers.size, 0);
  });
}

test('teardown cancels scheduled verification retries and fences queued timer callback', async () => {
  const f = fixture();
  f.identity.resolve(false); f.scope.resolve(false);
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 1);
  const queued = [...f.timers.values()][0];
  f.unmount();
  assert.equal(f.timers.size, 0);
  const count = f.transitions.length;
  queued();
  assert.equal(f.transitions.length, count);
  assert.equal(f.transitions.at(-1).value, 'clear');
});
