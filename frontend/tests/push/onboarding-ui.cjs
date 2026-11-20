'use strict';
// Actual TS/TSX in a VM with fake hooks: no renderer, app, server, provider, database or network.
// Normally sources resolve from this test's checkout. --source-root permits a read-only review
// of an integrating checkout while this new test is still isolated in a worktree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
function resolveTypeScript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw Error('Installed TypeScript not found');
  }
}
const ts = resolveTypeScript();
const sourceFlag = process.argv.indexOf('--source-root');
if (sourceFlag !== -1) assert.ok(process.argv[sourceFlag + 1], '--source-root requires a directory');
const sourceRoot = sourceFlag === -1 ? path.resolve(__dirname, '../../src') : path.resolve(process.argv[sourceFlag + 1]);
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function load(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(sourceRoot, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, queueMicrotask, DOMException, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name} in ${relative}`); return mocks[name]; },
  }, { filename });
  return mod.exports;
}
function hooks() {
  const cells = [], effects = new Map(), pending = [];
  let cursor = 0, mounted = true, writes = 0, unmountedWrites = 0, externalUpdates = 0;
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]));
  const react = {
    createContext: value => ({ value, Provider: 'ContextProvider' }),
    useContext: context => context.value,
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], next => {
        writes++;
        if (!mounted) unmountedWrites++;
        cells[index] = typeof next === 'function' ? next(cells[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!(index in cells) || changed(cells[index], deps)) {
        cells[index] = deps;
        pending.push(() => {
          effects.get(index)?.cleanup?.();
          effects.set(index, { effect, cleanup: effect() });
        });
      }
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!(index in cells) || changed(cells[index].deps, deps)) cells[index] = { deps, value: factory() };
      return cells[index].value;
    },
    useSyncExternalStore(subscribe, snapshot) {
      react.useEffect(() => subscribe(() => { externalUpdates++; }), [subscribe]);
      return snapshot();
    },
  };
  react.useLayoutEffect = react.useEffect;
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  return {
    react,
    render(fn, props) {
      cursor = 0;
      const result = fn(props);
      while (pending.length) pending.shift()();
      return result;
    },
    replayEffects() {
      // StrictMode's setup -> cleanup -> setup cycle preserves hook cells and runs
      // the second setup synchronously, before microtask-based abandonment checks.
      for (const entry of effects.values()) entry.cleanup?.();
      for (const entry of effects.values()) entry.cleanup = entry.effect();
    },
    unmount() {
      mounted = false;
      for (const entry of effects.values()) entry.cleanup?.();
      effects.clear();
    },
    get writes() { return writes; },
    get unmountedWrites() { return unmountedWrites; },
    get externalUpdates() { return externalUpdates; },
  };
}
function all(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, result));
  else if (node?.props) { if (predicate(node)) result.push(node); all(node.props.children, predicate, result); }
  return result;
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node?.props) return text(node.props.children);
  return node == null || node === false ? '' : String(node);
}
function eventTarget(extra = {}) {
  const listeners = new Map();
  return { ...extra, listeners,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}
const profile = (paired = false) => ({ user: { id: 'A' }, couple: paired ? { id: 'couple-A' } : null });

function onboardingHarness(options = {}) {
  const h = hooks(), claim = deferred(), enable = deferred();
  const calls = { claim: [], finish: [], device: 0, enable: 0, permission: 0 };
  const policyListeners = new Set();
  let policyVersion = 0;
  class ApiRequestError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const current = {
    ready: true, generation: 'session-A', pathname: '/', permission: 'default',
    auth: { me: profile(), completedAuth: { generation: 'session-A', attempt: 1, source: 'login' }, space: 'couple' },
    state: 'off', serverEnabled: true, busy: false, error: null, explicitlyOff: false,
    ...options,
  };
  let switchOptions;
  const tokenStore = { generation: () => current.generation, isCurrent: value => current.generation === value };
  const module = load('features/push/PushOnboarding.tsx', {
    react: h.react, 'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: 'Link', useLocation: () => ({ pathname: current.pathname }) },
    '../../components/Icon': { Icon: 'Icon' }, '../auth/AuthContext': { useAuth: () => current.auth },
    '../../lib/tokenStore': { tokenStore }, '../../lib/apiClient': { ApiRequestError },
    './PushHelp': { deniedSteps: () => 'Open browser settings to allow notifications.' },
    './readiness': { usePushReadiness: () => current.ready },
    './onboardingPolicy': {
      claimOnboarding: (...args) => { calls.claim.push(args); return claim.promise; },
      finishOnboarding: (...args) => calls.finish.push(args),
      isPushExplicitlyOff: userId => { assert.equal(userId, 'A'); return current.explicitlyOff; },
      onboardingVersion: () => policyVersion,
      subscribeOnboarding: listener => { policyListeners.add(listener); return () => policyListeners.delete(listener); },
    },
    './usePushDevice': {
      usePushDevice: () => { calls.device++; return { state: current.state, serverEnabled: current.serverEnabled }; },
      usePushSwitch: opts => { switchOptions = opts; return { busy: current.busy, error: current.error,
        enable: () => { calls.enable++; return enable.promise; } }; },
    },
  }, { Notification: { get permission() { return current.permission; }, requestPermission() { calls.permission++; throw Error('Permission must originate in a tap'); } } });
  let child, removed = false;
  function renderGate() { return module.PushOnboarding(); }
  function render() {
    const next = renderGate();
    if (!next) { if (child && !removed) { h.unmount(); removed = true; } return null; }
    assert.equal(removed, false, 'Use a fresh harness for a new child mount');
    child = next;
    return h.render(child.type, child.props);
  }
  return { current, calls, claim, enable, h, render, renderGate, route: module.isPushOnboardingRoute,
    fail: code => switchOptions.onFailure(code), get switchOptions() { return switchOptions; },
    policyListeners,
    setExplicitlyOff(value) {
      current.explicitlyOff = value; policyVersion++;
      for (const listener of policyListeners) listener();
    },
    unmount: () => { h.unmount(); removed = true; },
    async show() { render(); claim.resolve(true); await tick(); return render(); },
  };
}
function primary(tree) { return all(tree, node => node.type === 'button' && node.props.className === 'btn btn-primary')[0]; }
function dismiss(tree) { return all(tree, node => node.type === 'button' && node.props.className === 'btn btn-secondary')[0]; }

test('pre-ready, partial auth, bootstrap-only and generation-mismatched mounts never inspect the device', () => {
  for (const change of [
    h => { h.current.ready = false; },
    h => { h.current.ready = false; h.current.auth.me = null; },
    h => { h.current.auth.completedAuth = null; },
    h => { h.current.auth.completedAuth.generation = 'previous-session'; },
  ]) {
    const h = onboardingHarness(); change(h);
    assert.equal(h.render(), null);
    assert.equal(h.calls.device, 0); assert.deepEqual(h.calls.claim, []);
    assert.equal(h.calls.enable, 0); assert.equal(h.calls.permission, 0);
  }
});

test('unpaired, paired and Friends users share one account/generation opportunity after readiness', async () => {
  for (const paired of [false, true]) for (const space of ['couple', 'friends']) {
    const h = onboardingHarness({ pathname: space === 'friends' ? '/friends' : '/' });
    h.current.auth.me = profile(paired); h.current.auth.space = space;
    const tree = await h.show();
    assert.equal(tree.type, 'aside');
    assert.deepEqual(h.calls.claim, [['A', 'session-A', 'default']]);
    assert.equal(h.calls.enable, 0); assert.equal(h.calls.permission, 0);
    assert.match(text(tree), /tài khoản trên máy này/);
    assert.match(text(tree), /ẩn tên người và nội dung/);
    assert.match(text(tree), /giờ yên lặng/);
    h.unmount(); await tick();
  }
});

test('login, recovery, invite, install, lock, settings, admin and wrong-space routes stay excluded', () => {
  const h = onboardingHarness();
  const shared = ['/install', '/j/secret', '/app-lock', '/friends/app-lock', '/unknown', '/friendsx', '/login/', '/install/', '/profile/notifications/', '/friends/me/notifications/'];
  for (const space of ['couple', 'friends']) {
    const blocked = space === 'couple'
      ? [...shared, '/login', '/password-change', '/profile/notifications', '/admin', '/admin/users', '/friends', '/friends/me']
      : [...shared, '/', '/login', '/password-change', '/friends/login', '/friends/me/notifications', '/admin'];
    for (const pathname of blocked) {
      h.current.pathname = pathname; h.current.auth.space = space;
      assert.equal(h.route(pathname, space), false, `${space}: ${pathname}`);
      assert.equal(h.renderGate(), null, `${space}: ${pathname} must not mount device hooks`);
    }
  }
  assert.equal(h.calls.device, 0);
  for (const pathname of ['/', '/pairing', '/moments', '/profile']) assert.equal(h.route(pathname, 'couple'), true);
  for (const pathname of ['/friends', '/friends/posts/123', '/friends/me']) assert.equal(h.route(pathname, 'friends'), true);
});

test('permission is never requested automatically; the original tap calls enable synchronously', async () => {
  for (const permission of ['default', 'granted']) {
    const h = onboardingHarness({ permission });
    const tree = await h.show();
    assert.deepEqual(h.calls.claim, [['A', 'session-A', permission]]);
    assert.equal(h.calls.enable, 0); assert.equal(h.calls.permission, 0);
    assert.equal(h.switchOptions.silent, true);
    primary(tree).props.onClick();
    assert.equal(h.calls.enable, 1, 'enable must run before any microtask/await');
    assert.deepEqual(h.calls.finish, []);
    h.enable.resolve(true); await tick();
    assert.equal(h.render(), null);
    assert.deepEqual(h.calls.finish, [['A', 'session-A', 'success']]);
    h.unmount(); await tick(); assert.equal(h.calls.finish.length, 1);
  }
});

test('async claim runs once across rerenders and StrictMode effect replay', async () => {
  const h = onboardingHarness();
  assert.equal(h.render(), null);
  h.h.replayEffects(); h.render(); h.render(); await tick();
  assert.equal(h.calls.claim.length, 1); assert.deepEqual(h.calls.finish, []);
  h.claim.resolve(true); await tick();
  assert.equal(h.render().type, 'aside');
  h.render(); assert.equal(h.calls.claim.length, 1);
  dismiss(h.render()).props.onClick();
  assert.equal(h.render(), null);
  assert.deepEqual(h.calls.finish, [['A', 'session-A', 'later']]);
  h.unmount(); await tick(); assert.equal(h.calls.finish.length, 1);
});

test('unclaimed or rejected async claims do not render, finish another owner, or retry', async () => {
  for (const rejected of [false, true]) {
    const h = onboardingHarness(); h.render();
    if (rejected) h.claim.reject(Error('storage unavailable')); else h.claim.resolve(false);
    await tick(); assert.equal(h.render(), null); h.render();
    assert.equal(h.calls.claim.length, 1); assert.deepEqual(h.calls.finish, []);
    h.unmount(); await tick(); assert.deepEqual(h.calls.finish, []);
  }
});

test('device loading/on/unsupported and unavailable or unknown configuration never claim', async () => {
  for (const state of ['loading', 'on', 'unsupported']) {
    const h = onboardingHarness({ state });
    assert.equal(h.render(), null); await tick();
    assert.deepEqual(h.calls.claim, []); assert.equal(h.calls.enable, 0);
  }
  for (const serverEnabled of [null, false]) {
    const h = onboardingHarness({ serverEnabled });
    assert.equal(h.render(), null); await tick(); assert.deepEqual(h.calls.claim, []);
  }
  const h = onboardingHarness({ state: 'loading', serverEnabled: null });
  h.render(); h.current.state = 'off'; h.render(); assert.equal(h.calls.claim.length, 0);
  h.current.serverEnabled = true; h.render(); assert.equal(h.calls.claim.length, 1);
});

test('denied permission gives manual instructions, and iOS install gives a link rather than permission', async () => {
  const denied = onboardingHarness({ state: 'denied', permission: 'denied' });
  const deniedTree = await denied.show();
  assert.match(text(deniedTree), /đang bị chặn/); assert.match(text(deniedTree), /Open browser settings/);
  assert.equal(primary(deniedTree), undefined); assert.equal(denied.calls.enable, 0);
  dismiss(deniedTree).props.onClick();
  assert.deepEqual(denied.calls.finish, [['A', 'session-A', 'denied']]);
  const ios = onboardingHarness({ state: 'ios-install' });
  const iosTree = await ios.show();
  assert.match(text(iosTree), /Màn hình chính/); assert.equal(primary(iosTree), undefined);
  const link = all(iosTree, node => node.type === 'Link')[0]; assert.equal(link.props.to, '/install');
  link.props.onClick(); assert.equal(ios.calls.enable, 0);
  assert.deepEqual(ios.calls.finish, [['A', 'session-A', 'later']]);
});

test('busy/retry/failure/default-dismissal UI preserves reason and does not silently retry', async () => {
  const h = onboardingHarness(); await h.show();
  h.current.busy = true;
  const busy = h.render();
  assert.ok(all(busy, node => node.type === 'button').every(node => node.props.disabled));
  assert.equal(all(busy, node => node.props.role === 'status').length, 1);
  h.current.busy = false; h.current.error = 'Try again later'; h.fail('network');
  const failed = h.render(); assert.match(text(primary(failed)), /Thử lại/);
  assert.match(text(all(failed, node => node.props.role === 'alert')[0]), /Try again later/);
  assert.equal(h.calls.enable, 0); assert.deepEqual(h.calls.finish, []);
  dismiss(failed).props.onClick(); assert.deepEqual(h.calls.finish, [['A', 'session-A', 'failure']]);
  const dismissed = onboardingHarness(); await dismissed.show(); dismissed.fail('dismissed');
  assert.equal(dismissed.render(), null);
  assert.deepEqual(dismissed.calls.finish, [['A', 'session-A', 'later']]);
  const denied = onboardingHarness(); await denied.show(); denied.fail('denied');
  denied.current.state = 'denied'; assert.match(text(denied.render()), /đang bị chặn/);
  assert.deepEqual(denied.calls.finish, []);
  dismiss(denied.render()).props.onClick(); assert.deepEqual(denied.calls.finish, [['A', 'session-A', 'denied']]);
});

test('route/readiness interruption releases an owned claim once, without cooldown or late UI writes', async () => {
  for (const phase of ['pending', 'shown']) for (const interruption of ['route', 'readiness', 'unmount']) {
    const h = onboardingHarness();
    if (phase === 'shown') await h.show(); else h.render();
    if (interruption === 'route') { h.current.pathname = '/moments'; h.render(); }
    else if (interruption === 'readiness') { h.current.ready = false; h.render(); }
    else h.unmount();
    await tick();
    const writes = h.h.writes;
    if (phase === 'pending') { h.claim.resolve(true); await tick(); }
    assert.deepEqual(h.calls.finish, [['A', 'session-A', 'interrupted']], `${phase}/${interruption}`);
    assert.equal(h.h.writes, writes, `${phase}/${interruption}: late claim cannot set state`);
    assert.equal(h.h.unmountedWrites, 0);
    if (interruption === 'route') assert.equal(h.render(), null);
  }
});

test('stale-generation claim and enable results never publish UI or success into the next account', async () => {
  const pending = onboardingHarness(); pending.render(); pending.current.generation = 'session-B';
  const before = pending.h.writes;
  pending.claim.resolve(true); await tick();
  assert.equal(pending.h.writes, before);
  assert.deepEqual(pending.calls.finish, [['A', 'session-A', 'interrupted']]);
  pending.unmount(); await tick(); assert.equal(pending.calls.finish.length, 1);
  assert.equal(pending.h.unmountedWrites, 0);
  for (const interruption of ['unmount', 'generation']) {
    const h = onboardingHarness(); const tree = await h.show(); primary(tree).props.onClick();
    if (interruption === 'unmount') h.unmount(); else h.current.generation = 'session-B';
    await tick(); const writes = h.h.writes, finishes = h.calls.finish.length;
    h.enable.resolve(true); await tick();
    assert.equal(h.h.writes, writes); assert.equal(h.calls.finish.length, finishes);
    assert.equal(h.h.unmountedWrites, 0);
    assert.ok(h.calls.finish.every(call => call[2] !== 'success'));
  }
});

test('late claim respects current device/config, and already-shown cards finish on availability changes', async () => {
  for (const phase of ['pending', 'shown']) for (const change of ['on', 'unsupported', 'config-off']) {
    const h = onboardingHarness();
    if (phase === 'shown') await h.show(); else h.render();
    if (change === 'config-off') h.current.serverEnabled = false; else h.current.state = change;
    h.render();
    if (phase === 'pending') { h.claim.resolve(true); await tick(); }
    assert.equal(h.render(), null, `${phase}/${change}`);
    assert.equal(h.calls.claim.length, 1);
    assert.equal(h.calls.finish.length, 1, `${phase}/${change}: owned reservation must be released`);
    assert.equal(h.calls.finish[0][2], phase === 'pending' ? 'interrupted' : change === 'on' ? 'success' : 'unavailable');
    assert.equal(h.calls.enable, 0);
    h.unmount(); await tick();
    assert.equal(h.calls.finish.length, 1, `${phase}/${change}: cleanup cannot finish twice`);
    assert.equal(h.h.unmountedWrites, 0);
  }
});

test('unavailable setup finishes immediately without showing retry or imposing failure cooldown', async () => {
  const h = onboardingHarness(); await h.show(); h.fail('unavailable');
  assert.equal(h.render(), null);
  assert.deepEqual(h.calls.finish, [['A', 'session-A', 'unavailable']]);
  assert.equal(h.calls.enable, 0);
  h.unmount(); await tick(); assert.equal(h.calls.finish.length, 1); assert.equal(h.h.unmountedWrites, 0);
});

test('abandoned transient setup failures finish with failure rather than interruption or dismissal cooldown', async () => {
  for (const interruption of ['unmount', 'route', 'readiness']) {
    const h = onboardingHarness(); await h.show();
    h.fail('failed');
    assert.deepEqual(h.calls.finish, [], 'An inline retry must remain possible before abandonment');
    if (interruption === 'unmount') h.unmount();
    else if (interruption === 'route') { h.current.pathname = '/moments'; h.render(); }
    else { h.current.ready = false; h.render(); }
    await tick();
    // UI delegates the 24-hour duration to onboardingPolicy's failure reason.
    assert.deepEqual(h.calls.finish, [['A', 'session-A', 'failure']], interruption);
    assert.equal(h.h.unmountedWrites, 0);
    if (interruption === 'route') { h.unmount(); await tick(); assert.equal(h.calls.finish.length, 1); }
  }
});

test('caller guard fences finished, route, configuration and cross-tab OFF even for captured operations', async () => {
  for (const change of ['finished', 'route', 'config-off', 'config-unknown', 'explicit-off', 'unmount']) {
    const h = onboardingHarness(); const tree = await h.show();
    const guard = h.switchOptions.guard;
    assert.equal(typeof guard, 'function', 'Onboarding must provide the switch an eligibility guard');
    assert.doesNotThrow(guard);
    if (change === 'finished') dismiss(tree).props.onClick();
    else if (change === 'route') { h.current.pathname = '/moments'; h.render(); }
    else if (change === 'config-off' || change === 'config-unknown') {
      h.current.serverEnabled = change === 'config-off' ? false : null; h.render();
    } else if (change === 'explicit-off') h.setExplicitlyOff(true); // Deliberately before React rerenders.
    else h.unmount();
    assert.throws(guard, error => error.code === 'PUSH_CHANGED', change);
    assert.equal(h.calls.enable, 0);
    if (change !== 'unmount') h.unmount();
    await tick(); assert.equal(h.h.unmountedWrites, 0);
  }
});

test('mounted invitation observes policy version and disappears when another tab explicitly turns push OFF', async () => {
  const h = onboardingHarness(); assert.equal((await h.show()).type, 'aside');
  assert.equal(h.policyListeners.size, 1, 'Mounted invitation subscribes to account policy changes');
  const notifications = h.h.externalUpdates;
  h.setExplicitlyOff(true);
  assert.equal(h.h.externalUpdates, notifications + 1, 'Storage-policy changes schedule a new snapshot');
  assert.equal(h.render(), null);
  assert.equal(h.calls.enable, 0); assert.equal(h.calls.claim.length, 1);
  h.setExplicitlyOff(false); assert.equal(h.render(), null, 'Re-enabling does not resurrect the consumed opportunity');
  h.unmount(); await tick(); assert.equal(h.policyListeners.size, 0); assert.equal(h.h.unmountedWrites, 0);
});

test('cross-tab explicit OFF wins over a pending presentation claim without a transient card', async () => {
  const h = onboardingHarness(); assert.equal(h.render(), null);
  h.setExplicitlyOff(true);
  // Resolve before a render, exercising the async callback's live policy read, not only an effect.
  const writes = h.h.writes;
  h.claim.resolve(true); await tick();
  assert.equal(h.h.writes, writes, 'A late claim must not publish shown=true after explicit OFF');
  assert.equal(h.render(), null);
  assert.equal(h.calls.finish.length, 1); assert.equal(h.calls.finish[0][2], 'interrupted');
  h.unmount(); await tick(); assert.equal(h.calls.finish.length, 1); assert.equal(h.h.unmountedWrites, 0);
});

function readinessHarness() {
  const h = hooks();
  const document = eventTarget({ visibilityState: 'visible' }), window = eventTarget(), navigator = { onLine: true };
  const current = { auth: { me: profile(), loading: false, bootstrapError: false, passwordChange: null, space: 'couple' },
    lock: { phase: 'ready' }, verified: { generation: 'session-A', userId: 'A', space: 'couple' }, generation: 'session-A' };
  const { usePushReadiness } = load('features/push/readiness.ts', {
    react: h.react, '../auth/AuthContext': { useAuth: () => current.auth },
    '../appLock/AppLockBoundary': { useAppLock: () => current.lock },
    '../realtime/verification': { subscribeVerification() {}, getVerifiedIdentity: () => current.verified },
    '../../lib/tokenStore': { tokenStore: { generation: () => current.generation } },
  }, { document, window, navigator });
  return { h, current, document, window, navigator, render: () => h.render(usePushReadiness) };
}

test('readiness requires complete auth, ready PIN lock, and matching verified user/space/generation', () => {
  for (const mutation of [
    h => { h.current.auth.me = null; }, h => { h.current.auth.loading = true; },
    h => { h.current.auth.bootstrapError = true; }, h => { h.current.auth.passwordChange = { expiresAt: 'later' }; },
    ...['locked', 'loading', 'checking', 'error'].map(phase => h => { h.current.lock.phase = phase; }),
    h => { h.current.verified = null; },
    h => { h.current.verified.generation = 'old'; }, h => { h.current.verified.userId = 'B'; },
    h => { h.current.verified.space = 'friends'; }, h => { h.current.generation = 'new'; },
  ]) {
    const h = readinessHarness(); assert.equal(h.render(), true); mutation(h); assert.equal(h.render(), false); h.h.unmount();
  }
  for (const paired of [false, true]) for (const space of ['couple', 'friends']) {
    const h = readinessHarness(); h.current.auth.me = profile(paired);
    h.current.auth.space = space; h.current.verified.space = space;
    assert.equal(h.render(), true, `${paired}/${space}`); h.h.unmount();
  }
});

test('readiness follows visibility and offline events and removes all event handlers on cleanup', () => {
  const h = readinessHarness(); assert.equal(h.render(), true);
  h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange'); assert.equal(h.render(), false);
  h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange'); assert.equal(h.render(), true);
  h.navigator.onLine = false; h.window.dispatch('offline'); assert.equal(h.render(), false);
  h.navigator.onLine = true; h.window.dispatch('online'); assert.equal(h.render(), true);
  assert.equal(h.document.count(), 1); assert.equal(h.window.count(), 2);
  h.h.unmount(); assert.equal(h.document.count(), 0); assert.equal(h.window.count(), 0);
  for (const initial of ['hidden', 'offline']) {
    const cold = readinessHarness();
    if (initial === 'hidden') cold.document.visibilityState = 'hidden'; else cold.navigator.onLine = false;
    assert.equal(cold.render(), false); cold.h.unmount();
  }
});

test('verification clear initially has no identity; only successful identity publication enables readiness', () => {
  const calls = [], h = hooks();
  const api = load('features/realtime/verification.tsx', {
    react: h.react, 'react/jsx-runtime': jsxRuntime, 'react-dom': { createPortal: (node, host) => ({ node, host }) },
    '../appLock/mask': { setAppMask: (...args) => calls.push(['mask', ...args]), setVerificationHost: host => calls.push(['host', host]) },
    './VerificationScreen': { VerificationScreen: 'VerificationScreen' },
  }, { document: { createElement: () => ({ setAttribute() {} }), body: { appendChild: host => calls.push(['append', host]) } } });
  assert.equal(api.getVerificationStatus(), 'clear'); assert.equal(api.getVerifiedIdentity(), null);
  let notifications = 0; const stop = api.subscribeVerification(() => notifications++);
  const identity = { generation: 'session-A', userId: 'A', space: 'friends' };
  api.setVerification('clear', undefined, identity);
  assert.deepEqual(plain(api.getVerifiedIdentity()), identity);
  for (const status of ['checking', 'failed']) {
    api.setVerification(status, () => {}, identity);
    assert.equal(api.getVerificationStatus(), status); assert.equal(api.getVerifiedIdentity(), null);
    api.setVerification('clear', undefined, identity); assert.deepEqual(plain(api.getVerifiedIdentity()), identity);
  }
  api.setVerification('clear'); // RealtimeSync's effect cleanup, not a successful verification.
  assert.equal(api.getVerificationStatus(), 'clear'); assert.equal(api.getVerifiedIdentity(), null);
  assert.equal(notifications, 6); assert.equal(calls.filter(call => call[0] === 'host').length, 1);
  stop(); api.setVerification('checking'); assert.equal(notifications, 6);
});

function authHarness(options = {}) {
  const h = hooks(), calls = [], handlers = new Map();
  const document = eventTarget({ visibilityState: 'visible' });
  const window = eventTarget({ setTimeout: () => 1, clearTimeout() {} });
  let generation = 'session-0', tokens = options.persisted ? { accessToken: 'old-access', refreshToken: 'old-refresh' } : null;
  let space = options.space || 'couple', epoch = 1, lockRefresh = () => Promise.resolve();
  const lock = { phase: 'ready', discard: false };
  const tokenStore = { generation: () => generation, isCurrent: value => value === generation, get: () => tokens,
    set(value) { tokens = value; generation = `session-${Number(generation.split('-')[1]) + 1}`; calls.push(['tokens']); },
    clear() { tokens = null; generation = `session-${Number(generation.split('-')[1]) + 1}`; },
    isSessionKey: key => key === 'session', isTokenKey: key => key === 'tokens',
  };
  const qc = { cancelQueries: async () => { calls.push(['cancel']); }, clear: () => calls.push(['clear']) };
  const apiRequest = (url, opts) => {
    calls.push(['api', url, opts]);
    if (handlers.has(url)) return handlers.get(url)(opts);
    if (url === '/me') return Promise.resolve(profile());
    if (url === '/friends/join') return Promise.resolve({ joined: true });
    if (url === '/auth/login' || url === '/auth/register' || url === '/auth/password-change') return Promise.resolve({ accessToken: 'access', refreshToken: 'refresh' });
    throw Error(`Unhandled request ${url}`);
  };
  const { AuthProvider } = load('features/auth/AuthContext.tsx', {
    react: h.react, 'react/jsx-runtime': jsxRuntime, '@tanstack/react-query': { useQueryClient: () => qc },
    '../../lib/commentDraftStore': { commentDraftStore: { sessionChanged() {}, revokeCouple() {} } },
    '../../lib/apiClient': { SESSION_EXPIRED_EVENT: 'expired', apiRequest, advanceAccessEpoch() {}, currentAccessEpoch: () => 0, waitForAbort: promise => promise,
      assertCurrentSession(value) { if (!tokenStore.isCurrent(value)) throw new DOMException('Session changed', 'AbortError'); } },
    '../../lib/tokenStore': { tokenStore },
    '../../lib/spaceStore': { spaceStore: { get: () => space, set: value => { space = value; }, isSpaceKey: key => key === 'space' } },
    '../push/device': { forgetThisDevice: async () => calls.push(['forget']) },
    '../appLock/store': {
      activateAppLock: () => () => {}, appLockEpoch: () => epoch, appLockState: () => lock,
      bindPasswordLogin: () => calls.push(['bind']), isAuthAttemptCurrent: value => value === epoch,
      refreshLockSettings: (...args) => { calls.push(['lock-settings', ...args]); return lockRefresh(); },
      resetAppLock() {}, subscribeAppLock: () => () => {},
    },
  }, { document, window });
  const render = () => h.render(AuthProvider, { children: 'private' }).props.value;
  return { h, calls, handlers, document, window, tokenStore, render,
    async boot() { render(); await tick(); return render(); },
    setLockRefresh(fn) { lockRefresh = fn; }, changeEpoch() { epoch++; },
    changeGeneration() { generation = `session-${Number(generation.split('-')[1]) + 1}`; },
  };
}

test('actual AuthProvider bootstrap, refreshMe and verification never emit completedAuth', async () => {
  for (const persisted of [false, true]) {
    const h = authHarness({ persisted });
    const initial = h.render(); assert.equal(initial.completedAuth, null); assert.equal(initial.loading, true);
    await tick(); let value = h.render(); assert.equal(value.loading, false); assert.equal(value.completedAuth, null);
    assert.equal(value.isAuthenticated, persisted);
    await value.refreshMe(); value = h.render(); assert.equal(value.completedAuth, null);
    if (persisted) { assert.equal(await value.verifyMe(), true); assert.equal(h.render().completedAuth, null); }
    h.h.unmount();
  }
});

test('equivalent verifyMe calls share a flight; revoke fences its late response', async () => {
  const h = authHarness({ persisted: true }); await h.boot();
  const held = deferred(); let calls = 0;
  h.handlers.set('/me', () => { calls++; return held.promise; });
  const auth = h.render(), first = auth.verifyMe(), second = auth.verifyMe(), refresh = auth.refreshMe();
  assert.equal(calls, 1);
  auth.revokeMe(true);
  const fresh = deferred(); h.handlers.set('/me', () => { calls++; return fresh.promise; });
  const replacement = auth.verifyMe(); assert.equal(calls, 2);
  held.resolve(profile()); assert.equal(await first, false); assert.equal(await second, false); await refresh;
  fresh.resolve(profile(false)); assert.equal(await replacement, true);
  assert.equal(h.render().me.couple, null); h.h.unmount();
});

test('actual AuthProvider publishes completedAuth only after final explicit login/register steps', async () => {
  for (const method of ['login', 'register']) for (const space of ['couple', 'friends']) {
    const h = authHarness(); await h.boot();
    const credentials = deferred(), me = deferred(), settings = deferred(), join = deferred();
    h.handlers.set(`/auth/${method}`, () => credentials.promise); h.handlers.set('/me', () => me.promise);
    h.handlers.set('/friends/join', () => join.promise); h.setLockRefresh(() => settings.promise);
    let joinedCallback = 0;
    const opts = { onJoined() { joinedCallback++; assert.equal(h.render().completedAuth, null); } };
    const value = h.render();
    const result = method === 'login' ? value.login('a@example.test', 'pass', space, opts)
      : value.register('a@example.test', 'pass', 'A', space, opts);
    assert.equal(h.render().completedAuth, null);
    credentials.resolve({ accessToken: 'access', refreshToken: 'refresh' }); await tick();
    assert.equal(h.render().completedAuth, null);
    if (space === 'friends') { assert.equal(h.calls.filter(call => call[1] === '/me').length, 0); join.resolve({ joined: true }); await tick(); }
    me.resolve(profile()); await tick();
    assert.equal(h.render().completedAuth, null, 'PIN/settings must finish before the opportunity');
    settings.resolve(); await result;
    assert.deepEqual(plain(h.render().completedAuth), { generation: h.tokenStore.generation(), attempt: 1, source: method });
    assert.equal(joinedCallback, 1); h.h.unmount();
  }
});

test('actual AuthProvider limited password-change login never emits completion until recovery promotes tokens', async () => {
  const h = authHarness(); await h.boot();
  h.handlers.set('/auth/login', async () => ({ status: 'password_change_required', passwordChangeToken: 'limited', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await h.render().login('a@example.test', 'temporary');
  let value = h.render();
  assert.equal(value.completedAuth, null); assert.equal(value.isAuthenticated, false); assert.ok(value.passwordChange);
  assert.equal(h.tokenStore.get(), null); assert.equal(h.calls.some(call => call[1] === '/me'), false);
  const change = deferred(); h.handlers.set('/auth/password-change', () => change.promise);
  const result = value.completePasswordChange('new-password', 'new-password');
  assert.equal(h.render().completedAuth, null);
  change.resolve({ accessToken: 'new-access', refreshToken: 'new-refresh' }); await result;
  value = h.render(); assert.equal(value.passwordChange, null);
  assert.deepEqual(plain(value.completedAuth), { generation: h.tokenStore.generation(), attempt: 1, source: 'recovery' });
  h.h.unmount();
});

test('actual AuthProvider failed/cancelled/stale credentials and failed Friends join never emit completion', async () => {
  for (const interruption of ['failure', 'cancel', 'generation', 'lock', 'unmount', 'friends-join']) {
    const h = authHarness(); await h.boot(); const credentials = deferred();
    h.handlers.set('/auth/login', () => credentials.promise);
    if (interruption === 'friends-join') h.handlers.set('/friends/join', async () => { throw Error('Join unavailable'); });
    const result = h.render().login('a@example.test', 'pass', interruption === 'friends-join' ? 'friends' : 'couple');
    const rejected = assert.rejects(result);
    if (interruption === 'cancel') h.render().cancelLoginAttempt();
    if (interruption === 'generation') h.changeGeneration();
    if (interruption === 'lock') h.changeEpoch();
    if (interruption === 'unmount') h.h.unmount();
    if (interruption === 'failure') credentials.reject(Error('Invalid credentials'));
    else credentials.resolve({ accessToken: 'access', refreshToken: 'refresh' });
    await rejected;
    if (interruption !== 'unmount') { assert.equal(h.render().completedAuth, null); h.h.unmount(); }
    else assert.equal(h.calls.filter(call => call[0] === 'tokens').length, 0);
  }
});

test('absorbed /me failure cannot show onboarding until current-account verification recovers', async () => {
  const auth = authHarness(); await auth.boot();
  auth.handlers.set('/me', async () => { throw Error('Offline'); });
  await auth.render().login('a@example.test', 'pass');
  const failed = auth.render();
  // Explicit-auth metadata is not proof of successful /me or realtime access verification.
  assert.ok(failed.completedAuth); assert.equal(failed.me, null); assert.equal(failed.bootstrapError, true);
  const readiness = readinessHarness(), ui = onboardingHarness();
  readiness.current.auth = failed; readiness.current.generation = auth.tokenStore.generation(); readiness.current.verified = null;
  ui.current.auth = failed; ui.current.generation = auth.tokenStore.generation(); ui.current.ready = readiness.render();
  assert.equal(ui.renderGate(), null); assert.equal(ui.calls.device, 0);
  auth.handlers.set('/me', async () => profile());
  failed.retryBootstrap(); await tick(); readiness.current.auth = auth.render();
  assert.ok(readiness.current.auth.me); assert.equal(readiness.render(), false, 'Successful bootstrap alone does not verify access');
  readiness.current.verified = { generation: auth.tokenStore.generation(), userId: 'A', space: 'couple' };
  assert.equal(readiness.render(), true);
  ui.current.auth = auth.render(); ui.current.ready = readiness.render();
  assert.ok(ui.renderGate(), 'Recovered verified explicit auth may use its unconsumed opportunity');
  auth.h.unmount(); readiness.h.unmount();
});

test('actual AuthProvider final guards reject interrupted /me, settings, and onJoined completion', async () => {
  for (const phase of ['me', 'settings', 'onJoined']) {
    const h = authHarness(); await h.boot(); const blocked = deferred();
    if (phase === 'me') h.handlers.set('/me', () => blocked.promise);
    if (phase === 'settings') h.setLockRefresh(() => blocked.promise);
    const opts = phase === 'onJoined' ? { onJoined: () => h.changeGeneration() } : undefined;
    const login = h.render().login('a@example.test', 'pass', 'couple', opts);
    const rejected = assert.rejects(login);
    if (phase !== 'onJoined') {
      await tick(); assert.equal(h.render().completedAuth, null);
      h.changeGeneration(); blocked.resolve(phase === 'me' ? profile() : undefined);
    }
    await rejected; assert.equal(h.render().completedAuth, null); h.h.unmount();
  }
});

test('actual AuthProvider clears completion at next attempt/logout/cross-tab session replacement', async () => {
  for (const change of ['attempt', 'logout', 'storage']) {
    const h = authHarness(); await h.boot(); await h.render().login('a@example.test', 'pass');
    assert.ok(h.render().completedAuth);
    if (change === 'attempt') {
      const next = deferred(); h.handlers.set('/auth/login', () => next.promise);
      const login = h.render().login('b@example.test', 'bad'); const rejected = assert.rejects(login);
      assert.equal(h.render().completedAuth, null); next.reject(Error('Wrong password')); await rejected;
    } else if (change === 'logout') h.render().logout();
    else { h.changeGeneration(); h.window.dispatch('storage', { key: 'session', newValue: 'new' }); await tick(); }
    assert.equal(h.render().completedAuth, null); h.h.unmount();
  }
});
