'use strict';
// Isolated transport state and synthetic credential checks; no DB/server/provider.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const state = { version: 0, pending: false, checks: 0, wait: null };
  const intervals = new Set();
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/realtime.service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, Date, queueMicrotask,
    setTimeout, clearTimeout,
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
    require(name) {
      assert.equal(name, './credential.service.js');
      return { credentialService: { async assertApp(_id, version) {
        state.checks++;
        const allowed = version === state.version && !state.pending;
        if (state.wait) await state.wait;
        if (!allowed) throw new Error('revoked');
      } } };
    },
  });
  class Response extends EventEmitter {
    writableLength = 0; writableEnded = false; destroyed = false; writes = [];
    write(value) { this.writes.push(value); return true; }
    end() { this.writableEnded = true; }
  }
  const service = mod.exports.realtimeService;
  return { state, service, intervals, Response };
}
test('credential reset closes active streams and a pending readiness check cannot reopen them', async () => {
  const h = harness();
  try {
    let release;
    h.state.wait = new Promise(resolve => { release = resolve; });
    const res = new h.Response();
    assert.equal(h.service.subscribe('user', 0, 'couple', res, Date.now() + 30000), true);
    h.state.version = 1;
    h.service.revokeUser('user');
    release(); await tick();
    assert.equal(res.writableEnded, true);
    assert.deepEqual(res.writes, []);
  } finally { h.service.drain(); }
});
test('ready precedes queued events and stale event checks close without delivery', async () => {
  const h = harness();
  try {
    const res = new h.Response();
    h.service.subscribe('user', 0, 'couple', res, Date.now() + 30000);
    h.service.publish(['user'], 'couple', ['moments']);
    await tick();
    assert.match(res.writes[0], /event: ready/);
    assert.match(res.writes[1], /event: dirty/);
    h.state.version++;
    h.service.publish(['user'], 'couple', ['water']);
    await tick();
    assert.equal(res.writes.length, 2);
    assert.equal(res.writableEnded, true);
  } finally { h.service.drain(); }
});
test('heartbeat detects a reset even without a local revoke signal', async () => {
  const h = harness();
  try {
    const res = new h.Response();
    h.service.subscribe('user', 0, 'friends', res, Date.now() + 30000);
    await tick();
    h.state.pending = true;
    for (const heartbeat of h.intervals) heartbeat();
    await tick();
    assert.equal(res.writes.length, 1);
    assert.equal(res.writableEnded, true);
    assert.equal(h.intervals.size, 0);
  } finally { h.service.drain(); }
});
test('new subscriptions with stale credentials never emit ready', async () => {
  const h = harness();
  try {
    h.state.version = 2;
    const res = new h.Response();
    h.service.subscribe('user', 1, 'couple', res, Date.now() + 30000);
    await tick();
    assert.deepEqual(res.writes, []);
    assert.equal(res.writableEnded, true);
  } finally { h.service.drain(); }
});
