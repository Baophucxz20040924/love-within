'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function load(relative, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Promise, ...globals, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name} in ${relative}`);
    return mocks[name];
  } }, { filename });
  return mod.exports;
}
function environment(idle = true) {
  const pending = new Map(); let next = 0;
  const window = {
    setTimeout(fn) { const id = ++next; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  if (idle) {
    window.requestIdleCallback = (fn, options) => { assert.equal(options.timeout, 5000); const id = ++next; pending.set(id, fn); return id; };
    window.cancelIdleCallback = id => pending.delete(id);
  }
  const document = { visibilityState: 'visible' };
  const navigator = { onLine: true };
  const { scheduleRoutePrefetch } = load('lib/routePrefetch.ts', {}, { window, document, navigator });
  return { window, document, navigator, pending, scheduleRoutePrefetch, run() {
    const item = pending.entries().next().value; assert.ok(item, 'expected scheduled callback');
    pending.delete(item[0]); item[1]();
  } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function candidates(relative, exportName, expected) {
  const calls = [];
  const mocks = { react: { lazy: loader => loader } };
  for (const name of expected) mocks[name] = {};
  const selected = load(relative, mocks)[exportName];
  // Intercept actual dynamic import requires to verify which loaders were selected.
  for (const name of expected) Object.defineProperty(mocks, name, { get() { calls.push(name); return {}; }, configurable: true });
  return { selected, calls };
}

test('actual allowlists select only top-level pages and honor initial/current route', async () => {
  for (const [file, name, imports, paths] of [
    ['app/lazyPages.ts', 'couplePrefetchCandidates', ['../pages/QuestsPage', '../pages/StoriesPage'], ['/quests', '/stories']],
    ['features/friends/lazyPages.ts', 'friendsPrefetchCandidates', ['../../pages/FriendsPeoplePage', '../../pages/FriendEventsPage'], ['/friends/people', '/friends/events']],
  ]) {
    const { selected, calls } = candidates(file, name, imports);
    assert.deepEqual(Array.from(selected, item => item.path), paths);
    const env = environment(); let current = paths[0] + '/';
    env.scheduleRoutePrefetch(selected, () => current);
    env.run(); await flush();
    assert.deepEqual(calls, [imports[1]]); assert.equal(env.pending.size, 0);
    const second = candidates(file, name, imports); const e = environment(); current = '/';
    e.scheduleRoutePrefetch(second.selected, () => current);
    current = paths[0]; e.run(); await flush();
    assert.equal(e.pending.size, 1); e.run(); await flush();
    assert.deepEqual(second.calls, [imports[1]]);
  }
});

test('sequential idle opportunities, bounded budget, failures and cancellation', async () => {
  const e = environment(); let resolve; const calls = [];
  const items = [
    { path: '/a', load: () => { calls.push('a'); return new Promise(r => { resolve = r; }); } },
    { path: '/b', load: () => { calls.push('b'); return Promise.reject(new Error('offline')); } },
    { path: '/c', load: () => { calls.push('c'); return Promise.resolve(); } },
  ];
  e.scheduleRoutePrefetch(items, () => '/'); e.run(); await flush();
  assert.deepEqual(calls, ['a']); assert.equal(e.pending.size, 0);
  resolve(); await flush(); assert.equal(e.pending.size, 1);
  e.run(); await flush(); assert.deepEqual(calls, ['a', 'b']); assert.equal(e.pending.size, 0);
  const f = environment(); let finish; const seen = [];
  const cancel = f.scheduleRoutePrefetch([{ path: '/a', load: () => { seen.push('a'); return new Promise(r => { finish = r; }); } }, items[1]], () => '/');
  f.run(); cancel(); finish(); await flush(); assert.deepEqual(seen, ['a']); assert.equal(f.pending.size, 0);
  const g = environment(); const stop = g.scheduleRoutePrefetch(items, () => '/'); stop(); assert.equal(g.pending.size, 0);
});

test('all gates apply at enqueue and callback, and between imports', async () => {
  for (const block of [e => { e.document.visibilityState = 'hidden'; }, e => { e.navigator.onLine = false; },
    e => { e.navigator.connection = { saveData: true }; }, ...['slow-2g', '2g', '3g'].map(type => e => { e.navigator.connection = { effectiveType: type }; })]) {
    const first = environment(); block(first); let calls = 0;
    first.scheduleRoutePrefetch([{ path: '/a', load: () => { calls++; return Promise.resolve(); } }], () => '/');
    assert.equal(first.pending.size, 0); assert.equal(calls, 0);
    const second = environment(); second.scheduleRoutePrefetch([{ path: '/a', load: () => { calls++; return Promise.resolve(); } }], () => '/');
    block(second); second.run(); await flush(); assert.equal(calls, 0); assert.equal(second.pending.size, 0);
    const third = environment();
    third.scheduleRoutePrefetch([{ path: '/a', load: () => { calls++; block(third); return Promise.resolve(); } }, { path: '/b', load: () => { calls++; return Promise.resolve(); } }], () => '/');
    third.run(); await flush(); assert.equal(calls, 1); assert.equal(third.pending.size, 0);
  }
});

test('timeout fallback cleans up and StrictMode replay cannot run cancelled work', async () => {
  const e = environment(false); let calls = 0;
  const items = [{ path: '/a', load: () => { calls++; throw new Error('sync'); } }, { path: '/b', load: () => { calls++; return Promise.resolve(); } }];
  const cleanup = e.scheduleRoutePrefetch(items, () => '/'); cleanup();
  e.scheduleRoutePrefetch(items, () => '/'); assert.equal(e.pending.size, 1);
  e.run(); assert.equal(e.pending.size, 1); e.run(); await flush();
  assert.equal(calls, 2); assert.equal(e.pending.size, 0);
});
