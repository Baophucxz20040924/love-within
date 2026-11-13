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
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const values = new Map([
    ['lw.sessionGeneration', 'old'], ['lw.accessToken', 'old-access'], ['lw.refreshToken', 'old-refresh'],
  ]);
  const calls = { get: 0, clear: 0, cancel: 0, cacheClear: 0, requests: [] };
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
    clear() { calls.clear++; },
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
        assert.equal(url, '/me');
        const request = deferred();
        calls.requests.push(request);
        return request.promise;
      },
      assertCurrentSession: () => { throw new Error('unexpected session operation'); },
    },
    '../../lib/spaceStore': { spaceStore: { get: () => 'couple', set: () => {}, isSpaceKey: () => false } },
    '../../lib/tokenStore': { tokenStore },
    '../push/device': { forgetThisDevice: () => { throw new Error('unexpected device operation'); } },
    '../../components/StatusViews': { ErrorState: 'error', Loading: 'loading' },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports,
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

  // Rotation stays in the same generation and must not clear the current view or credentials.
  values.set('lw.accessToken', 'rotated-access');
  storage({ key: 'lw.accessToken', newValue: 'rotated-access' });
  values.set('lw.refreshToken', 'rotated-refresh');
  storage({ key: 'lw.refreshToken', newValue: 'rotated-refresh' });
  assert.equal(calls.requests.length, 4, 'both rotation writes trigger refresh');
  assert.equal(render().me, current);
  assert.equal(calls.cacheClear, 1, 'rotation does not clear cache');
  assert.equal(calls.clear, 0, 'rotation does not clear credentials');
  assert.equal(values.get('lw.sessionGeneration'), 'new');
  assert.equal(values.get('lw.accessToken'), 'rotated-access');
  assert.equal(values.get('lw.refreshToken'), 'rotated-refresh');
  calls.requests[2].resolve(current);
  calls.requests[3].resolve(current);
  await new Promise(setImmediate);

  values.delete('lw.accessToken');
  storage({ key: 'lw.accessToken', newValue: null });
  assert.equal(render().me, null, 'token removal clears identity');
  assert.equal(render().isAuthenticated, false);
  assert.equal(calls.cacheClear, 2, 'token removal clears cache');
  assert.equal(calls.cancel, 2);
  assert.equal(calls.clear, 0, 'storage events do not write credential clears');
  assert.equal(calls.requests.length, 4, 'token removal does not fetch without both credentials');
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(listeners.has('storage'), false);
  console.log('PASS: isolated AuthContext storage events, stale response, rotation and removal');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
