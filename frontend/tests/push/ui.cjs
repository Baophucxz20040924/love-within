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
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
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

test('PushSync waits for verified readiness and fences maintenance after masking/session change', async () => {
  const h = hooks(), calls = [], guards = [], events = new Map();
  let user = 'A', space = 'couple', ready = false, generation = 'g1', access = 1;
  const navigate = () => {};
  const { PushSync } = load('features/push/PushSync.tsx', {
    react: h.react, 'react-router-dom': { useNavigate: () => navigate },
    '../auth/AuthContext': { useAuth: () => ({ me: user ? { user: { id: user } } : null, space }) },
    './readiness': { usePushReadiness: () => ready },
    '../../lib/tokenStore': { tokenStore: { generation: () => generation, isCurrent: g => g === generation } },
    '../../lib/apiClient': { currentAccessEpoch: () => access },
    './device': { syncThisDevice: async (id, guard) => { guard(); calls.push(id); guards.push(guard); } },
    '../appLock/store': { appLockState: () => ({ settings: null }), lockForNavigation() {}, appLockEpoch: () => 1, isAppLocked: () => false },
    '../../lib/spaceStore': { spaceStore: { get: () => space } },
  }, { document: { visibilityState: 'visible' }, navigator: { serviceWorker: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } } });
  h.render(PushSync); assert.deepEqual(calls, []);
  ready = true; h.render(PushSync); assert.deepEqual(calls, ['A']);
  space = 'friends'; h.render(PushSync); assert.deepEqual(calls, ['A']);
  access++; assert.throws(guards[0], /access changed/);
  ready = false; h.render(PushSync);
  generation = 'g2'; user = 'B'; ready = true; h.render(PushSync); assert.deepEqual(calls, ['A', 'B']);
  h.unmount(); assert.throws(guards[1], /access changed/); assert.equal(events.size, 0);
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
      './readiness': { usePushReadiness: () => false },
      '../../lib/tokenStore': { tokenStore: { generation: () => 'anonymous' } },
      '../../lib/apiClient': {},
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
  let user = 'A', space = 'couple', version = 0, generation = 'login-1';
  const { usePushDevice } = load('features/push/usePushDevice.ts', {
    react: h.react, '@tanstack/react-query': { useQuery: () => ({ data: { enabled: true } }) },
    '../../components/Toast': {}, '../auth/AuthContext': { useAuth: () => ({ me: user ? { user: { id: user } } : null, space }) },
    '../../lib/apiClient': {}, './api': { PUSH_CONFIG_KEY: ['push'], pushApi: {} },
    '../../lib/tokenStore': { tokenStore: { generation: () => generation, isCurrent: value => generation === value } },
    '../appLock/store': {}, '../realtime/verification': {}, './onboardingPolicy': {},
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
  generation = 'login-2';
  assert.equal(h.render(usePushDevice).state, 'loading', 'same user relogin must not show a previous login result');
  const oldLoginResult = pending.shift();
  generation = 'login-3';
  assert.equal(h.render(usePushDevice).state, 'loading');
  oldLoginResult('on'); await tick(); assert.equal(h.render(usePushDevice).state, 'loading');
  pending.shift()('off'); await tick(); assert.equal(h.render(usePushDevice).state, 'off');
  user = null; assert.equal(h.render(usePushDevice).state, 'loading');
  h.unmount(); assert.equal(events.size, 0);
});

function switchHarness() {
  const h = hooks(), calls = [], toasts = [], policy = [], failures = [];
  const state = { user: 'A', generation: 'login-1', locked: false, lockEpoch: 0, accessEpoch: 0,
    verification: 'clear', visible: 'visible', verified: { userId: 'A', generation: 'login-1', space: 'friends' } };
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  class ApiRequestError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  class PushSetupError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const device = {
    PushSetupError,
    enableOnThisDevice: (user, guard) => { guard(); calls.push(['enable', user, guard]); return pending; },
    disableOnThisDevice: async (...args) => calls.push(['disable', ...args]),
  };
  const { usePushSwitch } = load('features/push/usePushDevice.ts', {
    react: h.react, '@tanstack/react-query': {},
    '../../components/Toast': { useToast: () => Object.fromEntries(['success', 'info', 'error'].map(name => [name, value => toasts.push([name, value])])) },
    '../auth/AuthContext': { useAuth: () => ({ me: state.user ? { user: { id: state.user } } : null }) },
    '../../lib/apiClient': { ApiRequestError, currentAccessEpoch: () => state.accessEpoch },
    '../../lib/tokenStore': { tokenStore: { generation: () => state.generation, isCurrent: value => value === state.generation, get: () => state.user ? {} : null } },
    '../appLock/store': { appLockEpoch: () => state.lockEpoch, isAppLocked: () => state.locked },
    '../realtime/verification': { getVerifiedIdentity: () => state.verified, getVerificationStatus: () => state.verification },
    './onboardingPolicy': { recordPushEnabled: user => policy.push(user) },
    './api': {}, './device': device,
  }, { document: { get visibilityState() { return state.visible; } } });
  return { ...h, state, calls, toasts, policy, failures, device, complete, ApiRequestError, PushSetupError,
    render: (options = {}) => h.render(usePushSwitch, { onFailure: code => failures.push(code), ...options }) };
}

test('shared switch sends account id and synchronous guard and records explicit success', async () => {
  const h = switchHarness();
  h.complete();
  assert.equal(await h.render().enable(), true);
  await h.render().disable();
  assert.equal(h.calls[0][0], 'enable'); assert.equal(h.calls[0][1], 'A'); assert.equal(typeof h.calls[0][2], 'function');
  assert.deepEqual(h.calls[1], ['disable', 'A']);
  assert.deepEqual(h.policy, ['A']);
});

test('switch immediate ref rejects double taps before React rerenders', async () => {
  const h = switchHarness();
  const value = h.render();
  const first = value.enable();
  assert.equal(await value.enable(), false);
  await value.disable();
  assert.equal(h.calls.length, 1);
  h.complete(); assert.equal(await first, true);
});

for (const change of ['unmount', 'lock', 'lock-cycle', 'access', 'hidden', 'relogin', 'user', 'verification', 'identity', 'reverified']) {
  test(`switch silently discards a delayed result after ${change}`, async () => {
    const h = switchHarness();
    const old = h.render().enable();
    if (change === 'unmount') h.unmount();
    if (change === 'lock') h.state.locked = true;
    if (change === 'lock-cycle') h.state.lockEpoch++;
    if (change === 'access') h.state.accessEpoch++;
    if (change === 'hidden') h.state.visible = 'hidden';
    if (change === 'relogin') h.state.generation = 'login-2';
    if (change === 'user') { h.state.user = 'B'; h.render(); }
    if (change === 'verification') h.state.verification = 'checking';
    if (change === 'identity') h.state.verified = null;
    if (change === 'reverified') h.state.verified = { ...h.state.verified };
    assert.throws(() => h.calls[0][2](), { code: 'PUSH_CHANGED' });
    h.complete(); assert.equal(await old, false);
    assert.deepEqual(h.toasts, []); assert.deepEqual(h.policy, []); assert.deepEqual(h.failures, []);
  });
}

for (const code of ['dismissed', 'denied', 'failed', 'unavailable']) {
  test(`silent switch exposes ${code} inline without a toast`, async () => {
    const h = switchHarness();
    h.device.enableOnThisDevice = async () => { throw new h.PushSetupError(code, 'inline failure'); };
    assert.equal(await h.render({ silent: true }).enable(), false);
    const result = h.render({ silent: true });
    assert.equal(result.error, 'inline failure');
    assert.equal(result.lastFailure, code === 'unavailable' ? 'failed' : code);
    assert.equal(result.busy, false);
    assert.deepEqual(h.failures, [code]); assert.deepEqual(h.toasts, []); assert.deepEqual(h.policy, []);
  });
}

test('old operation completion cannot clear a newer login operation busy flag', async () => {
  const h = switchHarness();
  const old = h.render().enable();
  h.state.generation = 'login-2';
  h.state.verified = { ...h.state.verified, generation: 'login-2' };
  let newerComplete;
  h.device.enableOnThisDevice = () => new Promise(resolve => { newerComplete = resolve; });
  const newer = h.render().enable();
  h.complete(); assert.equal(await old, false);
  assert.equal(h.render().busy, true);
  newerComplete(); assert.equal(await newer, true);
  assert.equal(h.render().busy, false);
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
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'A' } } }) },
    './readiness': { usePushReadiness: () => true },
    './onboardingPolicy': { subscribeOnboarding() {}, onboardingVersion: () => 0, canSuggestPush: () => true },
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
