'use strict';
// Uses the same TypeScript + VM and fake-hook loader pattern as tests/moments.cjs; no app/server/provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const jsx = (type, props) => ({ type, props: props || {} });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function load(relative, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name]; },
  }, { filename });
  return mod.exports;
}
function hooks() {
  const cells = [], cleanups = [], effects = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], next => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!(index in cells) || deps.some((value, i) => value !== cells[index][i])) {
        cells[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = effect(); });
      }
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  return { react, render(fn, props) { cursor = 0; const result = fn(props); while (effects.length) effects.shift()(); return result; },
    unmount() { cleanups.forEach(fn => fn?.()); } };
}
function all(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, result));
  else if (node?.props) { if (predicate(node)) result.push(node); all(node.props.children, predicate, result); }
  return result;
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node?.props) return text(node.props.children);
  return node == null ? '' : String(node);
}

test('PushSync refreshes only for account changes, never space changes or anonymous mounts', async () => {
  const h = hooks(), calls = [], events = new Map();
  let user = 'A', space = 'couple';
  const navigate = () => {};
  const { PushSync } = load('features/push/PushSync.tsx', {
    react: h.react, 'react-router-dom': { useNavigate: () => navigate },
    '../auth/AuthContext': { useAuth: () => ({ me: user ? { user: { id: user } } : null, space }) },
    './device': { syncThisDevice: async (...args) => calls.push(args) },
    '../appLock/store': { appLockState: () => ({ settings: null }), lockForNavigation() {} },
    '../../lib/spaceStore': { spaceStore: { get: () => space } },
  }, { navigator: { serviceWorker: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } } });
  h.render(PushSync); assert.deepEqual(calls, [['A']]);
  space = 'friends'; h.render(PushSync); assert.deepEqual(calls, [['A']]);
  user = 'B'; h.render(PushSync); assert.deepEqual(calls, [['A'], ['B']]);
  user = null; h.render(PushSync); assert.equal(calls.length, 2);
  h.unmount(); assert.equal(events.size, 0);
  await tick();
});

test('warm notification entry ignores arbitrary routes; optional PIN is applied before neutral navigation', () => {
  for (const pin of [true, false, undefined]) for (const space of ['couple', 'friends']) {
    const h = hooks(), calls = [];
    let message;
    const settings = pin === undefined ? null : { couple: !pin, friends: !pin, [space]: pin };
    const { PushSync } = load('features/push/PushSync.tsx', {
      react: h.react, 'react-router-dom': { useNavigate: () => (...args) => calls.push(['navigate', ...args]) },
      '../auth/AuthContext': { useAuth: () => ({ me: null, space }) }, './device': {},
      '../appLock/store': { appLockState: () => ({ settings }), lockForNavigation: () => calls.push(['lock']) },
      '../../lib/spaceStore': { spaceStore: { get: () => space, set() { throw Error('Must not switch spaces'); } } },
    }, { navigator: { serviceWorker: { addEventListener: (_name, fn) => { message = fn; }, removeEventListener() {} } },
      localStorage: { setItem() { throw Error('Must not persist account intent'); } },
      sessionStorage: { setItem() { throw Error('Must not persist account intent'); } },
    });
    h.render(PushSync);
    for (const data of [null, {}, 'lw:notification-open', { type: 'lw:navigate', url: '/friends/posts/private' }, { type: 'other', url: '/' }]) message({ data });
    assert.deepEqual(calls, []);
    message({ data: { type: 'lw:notification-open', url: 'https://evil.example', space: 'other', userId: 'old' } });
    assert.deepEqual(plain(calls), [...(pin === false ? [] : [['lock']]), ['navigate', '/', { replace: true }]]);
  }
});

test('neutral entry retains existing authentication and selected-space route guards', () => {
  let current = 'friends', authenticated = false;
  const mocks = { 'react/jsx-runtime': jsxRuntime, 'react-router-dom': { Navigate: 'Navigate' },
    '../features/auth/AuthContext': { useAuth: () => ({ space: current, isAuthenticated: authenticated, loading: false }) },
    '../components/StatusViews': { Loading: 'Loading' }, '../lib/spaceStore': { homeOf: space => space === 'friends' ? '/friends' : '/' } };
  const { ProtectedRoute } = load('app/ProtectedRoute.tsx', mocks);
  const { RequireSpace } = load('app/RequireSpace.tsx', mocks);
  assert.equal(ProtectedRoute({ children: 'private' }).props.to, '/login');
  authenticated = true;
  assert.equal(ProtectedRoute({ children: 'private' }).props.children, 'private');
  assert.equal(RequireSpace({ space: 'couple', children: 'couple' }).props.to, '/friends');
  assert.equal(current, 'friends');
  current = 'couple';
  assert.equal(RequireSpace({ space: 'couple', children: 'couple' }).props.children, 'couple');
});

test('device hook is account-only in both spaces and hides stale account results while rechecking', async () => {
  const h = hooks(), calls = [], pending = [], events = new Map();
  let user = 'A', space = 'couple', version = 0;
  const { usePushDevice } = load('features/push/usePushDevice.ts', {
    react: h.react, '@tanstack/react-query': { useQuery: () => ({ data: { enabled: true } }) },
    '../../components/Toast': {}, '../auth/AuthContext': { useAuth: () => ({ me: user ? { user: { id: user } } : null, space }) },
    '../../lib/apiClient': {}, './api': { PUSH_CONFIG_KEY: ['push'], pushApi: {} },
    './device': { subscribeDevice() {}, deviceVersion: () => version,
      readDeviceState: (...args) => { calls.push(args); return new Promise(resolve => pending.push(resolve)); }, notifyDeviceChanged: () => version++ },
  }, { document: { visibilityState: 'visible', addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } });
  assert.equal(h.render(usePushDevice).state, 'loading');
  pending.shift()('on'); await tick(); assert.equal(h.render(usePushDevice).state, 'on');
  space = 'friends'; assert.equal(h.render(usePushDevice).state, 'on'); assert.deepEqual(calls, [['A']]);
  events.get('visibilitychange')(); assert.equal(h.render(usePushDevice).state, 'loading');
  const oldAccountResult = pending.shift();
  user = 'B'; assert.equal(h.render(usePushDevice).state, 'loading');
  oldAccountResult('on'); await tick(); assert.equal(h.render(usePushDevice).state, 'loading');
  pending.shift()('off'); await tick(); assert.equal(h.render(usePushDevice).state, 'off');
  assert.deepEqual(calls, [['A'], ['A'], ['B']]);
  user = null; assert.equal(h.render(usePushDevice).state, 'loading');
  h.unmount(); assert.equal(events.size, 0);
});

test('shared device switch passes only account id on enable and no parameters on disable', async () => {
  const h = hooks(), calls = [];
  const { usePushSwitch } = load('features/push/usePushDevice.ts', {
    react: h.react, '@tanstack/react-query': {},
    '../../components/Toast': { useToast: () => ({ success() {}, info() {}, error() {} }) },
    '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'A' } }, space: 'friends' }) },
    '../../lib/apiClient': {}, './api': {}, './device': {
      enableOnThisDevice: async (...args) => calls.push(['enable', ...args]), disableOnThisDevice: async (...args) => calls.push(['disable', ...args]),
    },
  });
  await h.render(usePushSwitch).enable(); await h.render(usePushSwitch).disable();
  assert.deepEqual(calls, [['enable', 'A'], ['disable']]);
});

test('both settings panels share device state, fixed privacy, and retain per-space category and quiet-hour controls', () => {
  for (const space of ['couple', 'friends']) for (const preview of [true, false]) {
    const h = hooks(), patches = [], hookCalls = [], deviceCalls = [];
    const settings = { groups: { stories: true }, preview, quiet: { enabled: false, from: '22:00', to: '07:00' } };
    const { PushSettingsPanel } = load('features/push/PushSettingsPanel.tsx', {
      react: h.react, 'react/jsx-runtime': jsxRuntime,
      '@tanstack/react-query': { useQueryClient: () => ({}), useQuery: () => ({ data: settings }), useMutation: () => ({ mutate: patch => patches.push(plain(patch)) }) },
      '../../components/Icon': { Icon: 'Icon' }, '../../components/StatusViews': {}, '../../components/Switch': { Switch: 'Switch' },
      '../../components/Toast': { useToast: () => ({}) }, '../auth/AuthContext': { useAuth: () => ({ me: { user: {} } }) },
      '../../lib/apiClient': {}, './api': { pushApi: {}, pushSettingsKey: value => ['push', value] }, './device': {},
      './PushHelp': { PushDeviceHelp: 'Help' }, './usePushDevice': {
        usePushDevice: (...args) => { hookCalls.push(args); return { state: 'on', serverEnabled: true }; },
        usePushSwitch: (...args) => { hookCalls.push(args); return { busy: false, enable: () => deviceCalls.push('on'), disable: () => deviceCalls.push('off') }; },
      },
    });
    const tree = h.render(PushSettingsPanel, { space, groups: [{ key: 'stories', label: 'Stories', hint: 'Category hint', icon: 'bookOpen' }], quietHint: 'Quiet hint' });
    assert.deepEqual(hookCalls, [[], []]);
    const copy = text(tree);
    assert.match(copy, /tài khoản đang đăng nhập trên máy này/); assert.match(copy, /không đổi khi chuyển không gian/);
    assert.match(copy, /Love Within · Bạn có một thông báo mới/); assert.match(copy, /nếu bạn đã bật khóa/);
    assert.doesNotMatch(copy, /Hiện nội dung/); assert.match(copy, /Quiet hint/);
    const switches = all(tree, node => node.type === 'Switch');
    assert.equal(switches.length, 3); assert.equal(switches[0].props.checked, true);
    switches[0].props.onChange(false); assert.deepEqual(deviceCalls, ['off']);
    switches[1].props.onChange(false); switches[2].props.onChange(true);
    assert.deepEqual(patches, [{ space, groups: { stories: false } }, { space, quiet: { enabled: true } }]);
  }
});

test('suggestion uses shared account-device hooks but keeps its local dismissal context', async () => {
  const calls = [], dismissed = [];
  const { PushSuggestCard } = load('features/push/PushSuggestCard.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react-router-dom': { Link: 'Link' }, '../../components/Icon': { Icon: 'Icon' }, './PushHelp': {},
    './suggest': { usePushSuggest: () => 'shown', pushSuggest: { dismiss: space => dismissed.push(space) } },
    './usePushDevice': { usePushDevice: (...args) => { calls.push(args); return { state: 'off', serverEnabled: true }; },
      usePushSwitch: (...args) => { calls.push(args); return { busy: false, enable: async () => true }; } },
  });
  const tree = PushSuggestCard({ space: 'friends', text: 'Suggestion' });
  assert.deepEqual(calls, [[], []]); assert.match(text(tree), /tài khoản trên máy này/);
  all(tree, node => node.type === 'button' && node.props.className === 'btn btn-primary')[0].props.onClick();
  await tick(); assert.deepEqual(dismissed, ['friends']);
});
