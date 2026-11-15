'use strict';

// Isolated execution of the actual AuthContext TSX; no browser, network or server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function resolveTypeScript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = resolveTypeScript();
// AUTH_SOURCE_ROOT, when set, is the checkout root, not its frontend/src directory.
const sourceRoot = process.env.AUTH_SOURCE_ROOT
  ? path.join(path.resolve(process.env.AUTH_SOURCE_ROOT), 'frontend', 'src')
  : path.resolve(__dirname, '../src');
const filename = path.join(sourceRoot, 'features/auth/AuthContext.tsx');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function main() {
  const values = new Map([
    ['lw.sessionGeneration', 'old'], ['lw.accessToken', 'old-access'], ['lw.refreshToken', 'old-refresh'],
  ]);
  const calls = { get: 0, clear: 0, cancel: 0, cacheClear: 0, requests: [], logins: 0 };
  let epoch = 0, visible = true;
  const tokenStore = {
    generation: () => values.get('lw.sessionGeneration') ?? 'legacy',
    isCurrent: (generation) => generation === tokenStore.generation(),
    get() {
      calls.get++;
      const accessToken = values.get('lw.accessToken');
      const refreshToken = values.get('lw.refreshToken');
      return accessToken && refreshToken ? { accessToken, refreshToken } : null;
    },
    isSessionKey: (key) => key === 'lw.sessionGeneration',
    isTokenKey: (key) => key === 'lw.accessToken' || key === 'lw.refreshToken',
    set(tokens) { values.set('lw.sessionGeneration', `login-${++calls.logins}`); values.set('lw.accessToken', tokens.accessToken); values.set('lw.refreshToken', tokens.refreshToken); },
    clear() { calls.clear++; values.delete('lw.accessToken'); values.delete('lw.refreshToken'); },
  };
  const cells = [];
  const effects = [];
  const listeners = new Map();
  let cursor = 0;
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => null,
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (value) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(effect) {
      const index = cursor++;
      if (!(index in cells)) { cells[index] = true; effects.push(effect); }
    },
  };
  const element = (type, props) => ({ type, props });
  const mocks = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@tanstack/react-query': { useQueryClient: () => ({
      cancelQueries: () => { calls.cancel++; return Promise.resolve(); },
      clear: () => { calls.cacheClear++; },
    }) },
    '../../lib/apiClient': {
      SESSION_EXPIRED_EVENT: 'session-expired',
      apiRequest: (url) => {
        const request = deferred();
        request.url = url;
        calls.requests.push(request);
        return request.promise;
      },
      assertCurrentSession: (generation) => { if (!tokenStore.isCurrent(generation)) throw new DOMException('session changed', 'AbortError'); },
      advanceAccessEpoch: () => {},
    },
    '../../lib/spaceStore': { spaceStore: { get: () => 'couple', set: () => {}, isSpaceKey: () => false } },
    '../../lib/tokenStore': { tokenStore },
    '../push/device': { forgetThisDevice: () => { throw new Error('unexpected device operation'); } },
    '../appLock/store': { appLockEpoch: () => epoch, appLockState: () => ({ discard: false }), bindPasswordLogin() {}, isAuthAttemptCurrent: expected => expected === epoch && visible, refreshLockSettings: async () => {}, resetAppLock() {}, subscribeAppLock: () => () => {} },
    '../../components/StatusViews': { ErrorState: 'error', Loading: 'loading' },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, DOMException,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import: ${name}`); return mocks[name]; },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
    },
  }, { filename });
  const render = () => { cursor = 0; return module.exports.AuthProvider({ children: null }).props.value; };
  render();
  const cleanups = effects.map((effect) => effect()).filter(Boolean);
  const storage = listeners.get('storage');
  assert.equal(typeof storage, 'function', 'storage effect registers a handler');
  assert.equal(calls.requests.length, 1, 'mount requests old identity');
  const oldRequest = calls.requests[0];

  // The generation event can arrive before either new token has been written.
  values.set('lw.sessionGeneration', 'new');
  values.delete('lw.accessToken');
  values.delete('lw.refreshToken');
  const getsBeforeGeneration = calls.get;
  storage({ key: 'lw.sessionGeneration', newValue: 'new' });
  assert.ok(calls.get > getsBeforeGeneration, 'generation event invokes refreshMe');
  assert.equal(calls.requests.length, 1, 'missing credentials do not fetch /me');
  assert.equal(render().isAuthenticated, false);
  assert.equal(calls.cacheClear, 1);

  values.set('lw.accessToken', 'new-access');
  storage({ key: 'lw.accessToken', newValue: 'new-access' });
  assert.equal(calls.requests.length, 1, 'one token alone does not fetch /me');
  values.set('lw.refreshToken', 'new-refresh');
  storage({ key: 'lw.refreshToken', newValue: 'new-refresh' });
  assert.equal(calls.requests.length, 2, 'completed credentials trigger /me');
  const current = { id: 'new-user' };
  calls.requests[1].resolve(current);
  await new Promise(setImmediate);
  assert.equal(render().me, current);
  assert.equal(render().isAuthenticated, true);

  oldRequest.resolve({ id: 'old-user' });
  await new Promise(setImmediate);
  assert.equal(render().me, current, 'late previous-generation /me is ignored');

  // A new atomic session record for the same generation is just a rotation.
  storage({ key: 'lw.sessionGeneration', newValue: 'new' });
  assert.equal(render().me, current);
  assert.equal(calls.cacheClear, 1, 'same-generation session event must not clear the view');

  // Rotation stays in the same generation and must not clear the current view or credentials.
  values.set('lw.accessToken', 'rotated-access');
  storage({ key: 'lw.accessToken', newValue: 'rotated-access' });
  values.set('lw.refreshToken', 'rotated-refresh');
  storage({ key: 'lw.refreshToken', newValue: 'rotated-refresh' });
  assert.equal(calls.requests.length, 3, 'rotation writes share the pending refresh');
  assert.equal(render().me, current);
  assert.equal(calls.cacheClear, 1, 'rotation does not clear cache');
  assert.equal(calls.clear, 0, 'rotation does not clear credentials');
  assert.equal(values.get('lw.sessionGeneration'), 'new');
  assert.equal(values.get('lw.accessToken'), 'rotated-access');
  assert.equal(values.get('lw.refreshToken'), 'rotated-refresh');
  calls.requests[2].resolve(current);
  await new Promise(setImmediate);

  values.delete('lw.accessToken');
  storage({ key: 'lw.accessToken', newValue: null });
  assert.equal(render().me, null, 'token removal clears identity');
  assert.equal(render().isAuthenticated, false);
  assert.equal(calls.cacheClear, 2, 'token removal clears cache');
  assert.equal(calls.cancel, 2);
  assert.equal(calls.clear, 0, 'storage events do not write credential clears');
  assert.equal(calls.requests.length, 3, 'token removal does not fetch without both credentials');
  // A join rejected after conceal must not log out the newly acquired session.
  let attempt = render().login('a', 'password', 'friends', { inviteCode: 'invite' });
  let result = attempt.then(() => null, error => error);
  assert.equal(calls.requests.at(-1).url, '/auth/login');
  calls.requests.at(-1).resolve({ accessToken: 'login-access', refreshToken: 'login-refresh' });
  await new Promise(setImmediate);
  assert.equal(calls.requests.at(-1).url, '/friends/join');
  epoch++; visible = false;
  calls.requests.at(-1).reject(new Error('join failed'));
  assert.ok(await result); assert.equal(calls.clear, 0, 'stale join failure must not clear credentials');
  assert.equal(values.get('lw.accessToken'), 'login-access');

  // A late successful join after conceal must not refresh data or return an invite.
  visible = true;
  attempt = render().login('a', 'password', 'friends', { inviteCode: 'invite' });
  result = attempt.then(() => null, error => error);
  calls.requests.at(-1).resolve({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  await new Promise(setImmediate);
  assert.equal(calls.requests.at(-1).url, '/friends/join');
  epoch++; calls.requests.at(-1).resolve({ joined: true });
  const requestCount = calls.requests.length;
  assert.equal((await result).name, 'AbortError');
  assert.equal(calls.requests.length, requestCount, 'stale join cannot start /me');
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(listeners.has('storage'), false);
  console.log('PASS: isolated AuthContext storage events, stale response, rotation and removal');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
