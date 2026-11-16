const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('../../node_modules/typescript');

// Both the push transport and shared authenticated/refresh client are real transpiled modules.
// Fetch, session storage and timers are entirely in-memory; no server or credentials are used.
const compile = relative => ts.transpileModule(fs.readFileSync(path.join(__dirname, relative), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const clientCode = compile('../../src/lib/apiClient.ts');
const apiCode = compile('../../src/features/push/api.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('Expected mocked request did not start');
}
function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'mock response', json: async () => ({ data }) };
}
function harness() {
  const h = { calls: [], timers: new Map(), events: [], fetch: async () => response({ success: true }) };
  let generation = 'alice-login';
  let sequence = 0;
  let tokens = { accessToken: 'alice-access', refreshToken: 'alice-refresh' };
  let nextTimer = 0;
  const tokenStore = {
    generation: () => generation,
    isCurrent: expected => generation === expected,
    get: () => tokens,
    rotate(next, expected) {
      if (generation !== expected) return false;
      tokens = next;
      return true;
    },
    clear(expected) {
      if (expected !== undefined && generation !== expected) return false;
      generation = `logout-${++sequence}`;
      tokens = null;
      return true;
    },
  };
  h.login = user => {
    generation = `${user}-login-${++sequence}`;
    tokens = { accessToken: `${user}-access`, refreshToken: `${user}-refresh` };
  };
  h.tokens = () => tokens;
  h.logout = () => tokenStore.clear();
  h.expireTimers = () => { for (const { callback } of [...h.timers.values()]) callback(); };
  const shared = {
    Headers, AbortController, DOMException,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    window: {
      setTimeout(callback, ms) { const id = ++nextTimer; h.timers.set(id, { callback, ms }); return id; },
      clearTimeout(id) { h.timers.delete(id); },
      dispatchEvent: event => h.events.push(event),
    },
    fetch(url, init) {
      h.calls.push({ url, init });
      return h.fetch(url, init);
    },
  };
  const client = {};
  vm.runInNewContext(clientCode, {
    ...shared, exports: client,
    require(name) {
      assert.equal(name, './tokenStore');
      return { tokenStore };
    },
  }, { filename: 'apiClient.ts' });
  const exports = {};
  vm.runInNewContext(apiCode, {
    ...shared, exports,
    require(name) {
      if (name === '../../lib/apiClient') return client;
      if (name === '../../lib/tokenStore') return { tokenStore };
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: 'push/api.ts' });
  return Object.assign(h, { api: exports.pushApi, client });
}
const endpoint = 'https://push.example.test/device';
const body = { endpoint, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } };
const operations = [
  { name: 'config', invoke: api => api.config(), method: 'GET', path: '/api/push/config', body: undefined },
  { name: 'subscribe', invoke: api => api.subscribe(body), method: 'POST', path: '/api/push/subscriptions', body },
  { name: 'unsubscribe', invoke: api => api.unsubscribe(endpoint), method: 'DELETE', path: '/api/push/subscriptions', body: { endpoint } },
];

for (const operation of operations) {
  test(`${operation.name} device transport ignores content access epoch but sends correct authenticated request`, async () => {
    const h = harness();
    const gate = deferred();
    h.fetch = () => gate.promise;
    const pending = operation.invoke(h.api);
    assert.equal(h.calls.length, 1);
    h.client.advanceAccessEpoch(); // entering/leaving a protected space is not a new login
    gate.resolve(response({ result: 'ok' }));
    assert.deepEqual(await pending, { result: 'ok' });
    const { url, init } = h.calls[0];
    assert.equal(url, operation.path);
    assert.equal(init.method, operation.method);
    assert.equal(init.headers.get('Authorization'), 'Bearer alice-access');
    assert.equal(init.headers.get('Content-Type'), 'application/json');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), operation.body);
    assert.equal(h.timers.size, 0);
  });

  test(`${operation.name} ignores access epoch changes while parsing response JSON`, async () => {
    const h = harness();
    const gate = deferred();
    let parsing = false;
    h.fetch = async () => ({ ...response(null), json: () => { parsing = true; return gate.promise; } });
    const pending = operation.invoke(h.api);
    await until(() => parsing);
    h.client.advanceAccessEpoch();
    gate.resolve({ data: { result: 'ok' } });
    assert.deepEqual(await pending, { result: 'ok' });
    assert.equal(h.timers.size, 0);
  });

  for (const boundary of ['fetch', 'response JSON']) {
    for (const change of ['logout', 'new account']) {
      test(`${operation.name} rejects ${change} during ${boundary} rather than accepting stale device response`, async () => {
        const h = harness();
        const gate = deferred();
        let started = false;
        h.fetch = boundary === 'fetch'
          ? () => { started = true; return gate.promise; }
          : async () => ({ ...response(null), json: () => { started = true; return gate.promise; } });
        const pending = settle(operation.invoke(h.api));
        await until(() => started);
        if (change === 'logout') h.logout(); else h.login('bob');
        gate.resolve(boundary === 'fetch' ? response({ result: 'stale' }) : { data: { result: 'stale' } });
        assert.equal((await pending).error?.code, 'SESSION_CHANGED');
        assert.equal(h.calls.length, 1, 'stale response must not be retried under the new account');
        assert.equal(h.timers.size, 0);
      });
    }
  }
}

test('space settings retain content access epoch protection', async () => {
  const h = harness();
  const gate = deferred();
  h.fetch = () => gate.promise;
  const pending = settle(h.api.settings('friends'));
  h.client.advanceAccessEpoch();
  gate.resolve(response({ enabled: true }));
  assert.equal((await pending).error?.code, 'ACCESS_CHANGED');
  assert.equal(h.calls[0].url, '/api/push/settings?space=friends');
});

test('device registration survives token rotation and access epoch change while refreshing', async () => {
  const h = harness();
  const refresh = deferred();
  h.fetch = (url, init) => {
    if (url === '/api/auth/refresh') return refresh.promise;
    return Promise.resolve(init.headers.get('Authorization') === 'Bearer alice-access' ? response(null, 401) : response({ device: 'ok' }));
  };
  const pending = h.api.subscribe(body);
  await until(() => h.calls.some(call => call.url === '/api/auth/refresh'));
  h.client.advanceAccessEpoch();
  refresh.resolve(response({ accessToken: 'alice-rotated', refreshToken: 'alice-refresh-rotated' }));
  assert.deepEqual(await pending, { device: 'ok' });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].init.headers.get('Authorization'), 'Bearer alice-rotated');
  assert.deepEqual(JSON.parse(h.calls[2].init.body), body);
  assert.equal(h.timers.size, 0);
});

test('old device refresh cannot rotate tokens or retry using a newly logged-in account', async () => {
  const h = harness();
  const refresh = deferred();
  h.fetch = url => url === '/api/auth/refresh' ? refresh.promise : Promise.resolve(response(null, 401));
  const pending = settle(h.api.subscribe(body));
  await until(() => h.calls.some(call => call.url === '/api/auth/refresh'));
  h.login('bob');
  refresh.resolve(response({ accessToken: 'stale-alice', refreshToken: 'stale-refresh' }));
  assert.equal((await pending).error?.code, 'SESSION_CHANGED');
  assert.equal(h.tokens().accessToken, 'bob-access');
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test('structured registration error is preserved and timer is cleared', async () => {
  const h = harness();
  h.fetch = async () => ({ ...response(null, 400), json: async () => ({ error: { code: 'BAD_ENDPOINT', message: 'bad endpoint' } }) });
  await assert.rejects(h.api.subscribe(body), { status: 400, code: 'BAD_ENDPOINT', message: 'bad endpoint' });
  assert.equal(h.timers.size, 0);
});

test('device network and JSON failures clear deadline and do not poison a later request', async () => {
  const h = harness();
  h.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(h.api.config(), /offline/);
  assert.equal(h.timers.size, 0);
  h.fetch = async () => ({ ...response(null), json: async () => { throw new SyntaxError('invalid JSON'); } });
  await assert.rejects(h.api.config(), /invalid JSON/);
  assert.equal(h.timers.size, 0);
  h.fetch = async () => response({ enabled: true, publicKey: 'AQID' });
  assert.deepEqual(await h.api.config(), { enabled: true, publicKey: 'AQID' });
  assert.equal(h.timers.size, 0);
});

test('deadline rejects while shared token refresh remains held, without aborting other refresh consumers', async () => {
  const h = harness();
  const refresh = deferred();
  h.fetch = (url, init) => {
    if (url === '/api/auth/refresh') return refresh.promise;
    return Promise.resolve(init.headers.get('Authorization') === 'Bearer alice-access'
      ? response(null, 401) : response({ result: 'fresh' }));
  };
  const other = h.client.apiRequest('/profile');
  await until(() => h.calls.some(call => call.url === '/api/auth/refresh'));
  let result;
  const pending = settle(h.api.subscribe(body)).then(value => { result = value; return value; });
  await until(() => h.calls.some(call => call.url === '/api/push/subscriptions'));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  h.expireTimers();
  await until(() => result !== undefined);
  assert.equal(result.error?.name, 'TimeoutError');
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(call => call.url === '/api/auth/refresh').length, 1);
  refresh.resolve(response({ accessToken: 'alice-rotated', refreshToken: 'alice-rotated-refresh' }));
  assert.deepEqual(await other, { result: 'fresh' });
  await pending;
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(h.calls.filter(call => call.url === '/api/push/subscriptions').length, 1, 'timed-out registration must not retry after refresh completes');
});

test('deadline rejects while JSON parsing remains held and later response cannot become success', async () => {
  const h = harness();
  const json = deferred();
  let parsing = false;
  h.fetch = async () => ({ ...response(null), json: () => { parsing = true; return json.promise; } });
  let result;
  const pending = settle(h.api.config()).then(value => { result = value; return value; });
  await until(() => parsing);
  h.expireTimers();
  await until(() => result !== undefined);
  assert.equal(result.error?.name, 'TimeoutError');
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls[0].init.signal.aborted, true);
  json.resolve({ data: { enabled: true, publicKey: 'stale' } });
  await pending;
  h.fetch = async () => response({ enabled: true, publicKey: 'fresh' });
  assert.deepEqual(await h.api.config(), { enabled: true, publicKey: 'fresh' });
});

test('device deadline aborts the in-flight fetch without real timers', async () => {
  const h = harness();
  h.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const pending = settle(h.api.subscribe(body));
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 15_000);
  h.expireTimers();
  assert.equal((await pending).error?.name, 'TimeoutError');
  assert.equal(h.timers.size, 0);
});
