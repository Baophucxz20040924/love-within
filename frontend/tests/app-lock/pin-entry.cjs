'use strict';
// Exercise the actual component in isolation; no browser, server or real timers.
// Set PIN_ENTRY_SOURCE_ROOT and PIN_ENTRY_DEPENDENCY_ROOT to test another checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const sourceRoot = process.env.PIN_ENTRY_SOURCE_ROOT || path.resolve(__dirname, '../../src');
const dependencyRoot = process.env.PIN_ENTRY_DEPENDENCY_ROOT || path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [dependencyRoot] }));
const filename = path.join(sourceRoot, 'features/appLock/PinEntry.tsx');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}
class ApiRequestError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
function harness() {
  let cursor = 0, epoch = 1, generation = 'a', now = 10000, nextTimer = 1, mounted = true;
  const cells = [], effects = [], timers = new Map(), calls = [], writes = [];
  const react = {
    useId: () => { cursor++; return 'pin'; },
    useState(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [cells[i], value => { writes.push(i); cells[i] = typeof value === 'function' ? value(cells[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useEffect(fn, deps) {
      const i = cursor++, previous = effects[i];
      if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
        previous?.cleanup?.();
        effects[i] = { deps, pending: fn };
      }
    },
  };
  function schedule(fn, delay, interval) { const id = nextTimer++; timers.set(id, { fn, at: now + delay, interval }); return id; }
  const element = (type, props) => ({ type, props: props || {} });
  const mocks = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    '../../lib/apiClient': { ApiRequestError },
    '../../lib/tokenStore': { tokenStore: { generation: () => generation, isCurrent: x => x === generation } },
    './store': { appLockEpoch: () => epoch, isAuthAttemptCurrent: x => x === epoch },
    './PinEntry.css': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, Date: { now: () => now }, Error, Number,
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: id => timers.delete(id),
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name]; },
  }, { filename });
  let tree;
  function render() {
    assert.ok(mounted);
    cursor = 0;
    tree = module.exports.PinEntry({ onComplete: code => { const request = deferred(); calls.push({ code, ...request }); return request.promise; } });
    for (const effect of effects) if (effect?.pending) { const fn = effect.pending; delete effect.pending; effect.cleanup = fn(); }
    return tree;
  }
  function input() { return find(tree, node => node.type === 'input'); }
  function status() { return find(tree, node => node.props.id === 'pin-status').props.children; }
  function key(label) { const button = find(tree, node => node.type === 'button' && node.props['aria-label'] === label); assert.ok(button); button.props.onClick(); render(); }
  function change(value) { input().props.onChange({ target: { value } }); render(); }
  function advance(ms) {
    const end = now + ms;
    while (true) {
      let selected;
      for (const [id, timer] of timers) if (timer.at <= end && (!selected || timer.at < selected.timer.at)) selected = { id, timer };
      if (!selected) break;
      now = selected.timer.at;
      if (selected.timer.interval) selected.timer.at += selected.timer.interval; else timers.delete(selected.id);
      selected.timer.fn();
      if (mounted) render();
    }
    now = end;
  }
  render();
  return { calls, writes, timers, input, status, key, change, render, advance,
    epoch() { epoch++; }, generation() { generation = 'b'; },
    unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); },
  };
}

test('partial input, backspace, keypad, leading zero and Enter share a single submission', async () => {
  const h = harness();
  h.change('0a12'); assert.equal(h.input().props.value, '012'); assert.equal(h.calls.length, 0);
  h.key('Xóa một số'); assert.equal(h.input().props.value, '01');
  for (const digit of ['2', '3', '4']) h.key(digit);
  assert.equal(h.calls.length, 0);
  h.key('5'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].code, '012345');
  assert.equal(h.input().props.value, ''); assert.equal(h.input().props.readOnly, true);
  h.change('012345'); h.key('5');
  let prevented = false; h.input().props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(); await tick(); h.render();
  assert.equal(h.input().props.readOnly, false);
  h.input().props.onKeyDown({ key: 'Enter', preventDefault() {} }); assert.equal(h.calls.length, 1);
  h.unmount();
});

test('invalid PIN locks briefly and clears timer on unmount', async () => {
  const h = harness(); h.change('123456'); h.calls[0].reject(new ApiRequestError('INVALID_PIN', 'wrong')); await tick(); h.render();
  assert.equal(h.input().props['aria-invalid'], true); assert.match(h.status(), /chưa đúng/);
  h.change('987654'); assert.equal(h.calls.length, 1);
  h.advance(599); assert.equal(h.input().props.readOnly, true);
  h.advance(1); assert.equal(h.input().props.readOnly, false); assert.equal(h.input().props['aria-invalid'], undefined);
  h.change('987654'); assert.equal(h.calls.length, 2);
  h.calls[1].reject(new ApiRequestError('INVALID_PIN', 'wrong')); await tick(); h.render();
  assert.equal(h.timers.size, 1); h.writes.length = 0; h.unmount();
  assert.equal(h.timers.size, 0); h.advance(1000); assert.equal(h.writes.length, 0);
});

test('network error is not invalid and 429 enforces countdown with interval cleanup', async () => {
  const h = harness(); h.change('123456'); h.calls[0].reject(new Error('offline')); await tick(); h.render();
  assert.equal(h.input().props['aria-invalid'], undefined); assert.match(h.status(), /kết nối/); assert.equal(h.input().props.readOnly, false);
  h.change('123456'); h.calls[1].reject(new ApiRequestError('RATE_LIMITED', 'Too many attempts', { retryAfterSeconds: 2 })); await tick(); h.render();
  assert.equal(h.input().props['aria-invalid'], undefined); assert.match(h.status(), /2 giây/); assert.equal(h.timers.size, 1);
  h.change('123456'); assert.equal(h.calls.length, 2);
  h.advance(1000); assert.match(h.status(), /1 giây/);
  h.advance(1000); assert.equal(h.input().props.readOnly, false); assert.equal(h.timers.size, 0);
  h.change('123456'); assert.equal(h.calls.length, 3);
  h.calls[2].reject(new ApiRequestError('RATE_LIMITED', 'Too many attempts', { retryAfterSeconds: 2 })); await tick(); h.render();
  assert.equal(h.timers.size, 1); h.writes.length = 0; h.unmount(); assert.equal(h.timers.size, 0); h.advance(3000); assert.equal(h.writes.length, 0);
});

for (const invalidation of ['epoch', 'generation', 'unmount']) for (const outcome of ['reject', 'resolve']) {
  test(`${invalidation} invalidates stale ${outcome} catch/finally`, async () => {
    const h = harness(); h.change('123456');
    h[invalidation](); h.writes.length = 0;
    if (outcome === 'reject') h.calls[0].reject(new ApiRequestError('INVALID_PIN', 'wrong')); else h.calls[0].resolve();
    await tick(); assert.deepEqual(h.writes, []); assert.equal(h.timers.size, 0);
    if (invalidation !== 'unmount') h.unmount();
  });
}
