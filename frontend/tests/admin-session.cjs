'use strict';
// Isolated TSX execution: no browser, server, provider or actual credentials.
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
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = resolveTypeScript();
const source = path.resolve(__dirname, '../src');
function load(file, mocks, globals = {}) {
  const filename = path.join(source, file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, DOMException, AbortController, TextEncoder, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function nodes(root, predicate) {
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(node => nodes(node, predicate));
  return [...(predicate(root) ? [root] : []), ...nodes(root.props?.children, predicate)];
}
function fixture() {
  let cursor = 0, location = { key: 'initial', pathname: '/admin/login' };
  const cells = [], pending = [], listeners = new Map(), timers = new Map(), requests = [];
  const document = { visibilityState: 'visible', title: '', documentElement: { dataset: {}, removeAttribute() {} },
    addEventListener(name, handler) { listeners.set(name, handler); }, removeEventListener(name) { listeners.delete(name); } };
  const window = { __lwAppLock: { protected: false }, addEventListener(name, handler) { listeners.set(name, handler); }, removeEventListener(name) { listeners.delete(name); },
    setTimeout(handler) { const id = timers.size + 1; timers.set(id, handler); return id; }, clearTimeout(id) { timers.delete(id); } };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    useCallback(fn, deps) { const index = cursor++; const old = cells[index];
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) cells[index] = { fn, deps };
      return cells[index].fn; },
    useEffect(fn, deps) { const index = cursor++; const old = cells[index];
      if (!old || !deps || deps.some((dep, i) => dep !== old.deps[i])) { cells[index] = { deps, cleanup: old?.cleanup }; pending.push(() => { old?.cleanup?.(); cells[index].cleanup = fn(); }); } },
  };
  react.useLayoutEffect = react.useEffect;
  const element = (type, props) => ({ type, props });
  class AdminApiError extends Error { constructor(status) { super('Rejected'); this.status = status; } }
  const module = load('features/admin/AdminApp.tsx', {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-router-dom': { Link: 'Link', Navigate: 'Navigate', Route: 'Route', Routes: 'Routes', useLocation: () => location },
    './api': { AdminApiError, adminRequest: (url, token, body, signal) => { const req = deferred(); requests.push({ ...req, url, token, body, signal }); return req.promise; } },
    './AdminPages': { AdminLoginPage: 'Login', AdminUsersPage: 'Users', AdminPasswordPage: 'Password' }, './admin.css': {},
  }, { window, document });
  const render = () => { cursor = 0; const tree = module.AdminApp(); pending.splice(0).forEach(fn => fn()); return tree; };
  const route = name => nodes(render(), node => node.type === 'Route' && node.props.element.type === name)[0]?.props.element.props;
  return { render, route, requests, document, window, listeners, timers,
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
    navigate(pathname) { location = { pathname, key: `key-${pathname}` }; render(); },
    async login() { const form = route('Login'); const result = { adminToken: 'synthetic-admin', expiresAt: new Date(Date.now() + 900_000).toISOString() };
      const promise = form.request('/login', { email: 'admin@phucxz.com', password: 'synthetic' }); requests.at(-1).resolve(result); form.onLogin(await promise); render(); },
  };
}

test('admin transport has no account credentials, cache or retries', async () => {
  const calls = [];
  let response = { ok: true, json: async () => ({ data: { changed: true } }) };
  const api = load('features/admin/api.ts', {}, { fetch: async (...args) => { calls.push(args); return response; } });
  await api.adminRequest('/change-password', 'admin-only', { currentPassword: 'synthetic' });
  assert.equal(calls[0][0], '/api/admin/change-password');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer admin-only');
  assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].credentials, 'omit');
  response = { ok: false, status: 500, json: async () => ({ error: { code: 'FAILED', message: 'Failed' } }) };
  await assert.rejects(api.adminRequest('/users/test/reset-password', 'admin-only', {}));
  assert.equal(calls.length, 2, 'ambiguous reset failure is never automatically retried');
});

test('admin initial load mounts no personal module or account query', () => {
  const f = fixture(); f.render();
  assert.equal(f.requests.length, 0);
  assert.ok(f.route('Login'));
  const app = fs.readFileSync(path.join(source, 'app/App.tsx'), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/PersonalApp'\)/);
  assert.doesNotMatch(app, /import \{.*AuthProvider|import \{.*PushSync|import \{.*RealtimeSync/);
  f.unmount();
});

for (const event of ['lw:app-lock', 'pagehide', 'expiry', 'logout', 'unmount']) {
  test(`admin ${event} discards session and rejects a delayed secret response`, async () => {
    const f = fixture(); await f.login();
    const promise = f.route('Users').request('/users/id/reset-password', {});
    const outcome = promise.catch(error => error);
    assert.equal(f.requests.at(-1).token, 'synthetic-admin');
    if (event === 'expiry') [...f.timers.values()][0]();
    else if (event === 'logout') nodes(f.render(), node => node.type === 'button')[0].props.onClick();
    else if (event === 'unmount') f.unmount();
    else f.listeners.get(event)();
    assert.equal(f.requests.at(-1).signal.aborted, true);
    f.requests.at(-1).resolve({ temporaryPassword: 'must-not-display', expiresAt: 'future', credentialVersion: 2 });
    assert.equal((await outcome).name, 'AbortError');
    if (event !== 'unmount') assert.ok(f.route('Login'));
  });
}

for (const interrupt of ['conceal', 'new-login', 'unmount']) {
  test(`admin rejects accepted login continuation after ${interrupt}`, async () => {
    const f = fixture();
    const form = f.route('Login');
    const result = { adminToken: 'synthetic-admin', expiresAt: new Date(Date.now() + 900_000).toISOString() };
    const first = form.request('/login', {});
    f.requests.at(-1).resolve(result);
    const accepted = await first; // Request passed its own guard; UI callback has not run yet.
    let second;
    if (interrupt === 'conceal') f.listeners.get('lw:app-lock')();
    if (interrupt === 'new-login') second = form.request('/login', {}).catch(() => null);
    if (interrupt === 'unmount') f.unmount();
    form.onLogin(accepted);
    if (interrupt !== 'unmount') assert.ok(f.route('Login'), 'stale continuation cannot establish admin session');
    if (second) { f.requests.at(-1).reject(new Error('synthetic failure')); await second; }
  });
}

test('password rules enforce UTF8 bcrypt ceiling and confirmation', () => {
  const policy = load('features/auth/passwordPolicy.ts', {});
  assert.ok(policy.newPasswordError('short', 'short'));
  assert.equal(policy.newPasswordError('long-enough', 'long-enough'), null);
  assert.ok(policy.newPasswordError('long-enough', 'different'));
  assert.equal(policy.newPasswordError('ắ'.repeat(24), 'ắ'.repeat(24)), null);
  assert.ok(policy.newPasswordError('ắ'.repeat(25), 'ắ'.repeat(25)));
});
