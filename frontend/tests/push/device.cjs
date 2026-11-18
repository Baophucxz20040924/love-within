const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('../../node_modules/typescript');

// Execute the shipped module; only Vite's build-time PROD constant is replaced.
const filename = path.join(__dirname, '../../src/features/push/device.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env.PROD', 'true'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const KEY = 'lw.push.device';
const PUBLIC_KEY = 'AQID';
const ROTATED_KEY = 'BAUG';
const NOW = 1_800_000_000_000;
const ENDPOINT = 'https://push.example.test/device-original';
const clone = value => JSON.parse(JSON.stringify(value));
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
  assert.fail('Expected mocked operation did not start');
}
function record(overrides = {}) {
  return { userId: 'alice', endpoint: ENDPOINT, syncedAt: NOW, version: 2, ...overrides };
}
function harness(options = {}) {
  const storage = options.shared?.storage ?? new Map();
  if (options.record) storage.set(KEY, JSON.stringify(options.record));
  if (options.rawRecord !== undefined) storage.set(KEY, options.rawRecord);
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const session = options.shared?.session ?? {
    generation: 'alice-login', tokens: { accessToken: 'alice-access', refreshToken: 'alice-refresh' },
  };
  let sequence = 0;
  const h = {
    calls, storage, timers, now: NOW, sub: null,
    permission: options.permission ?? 'granted',
    permissionResult: options.permissionResult ?? 'granted',
    config: { enabled: true, publicKey: PUBLIC_KEY },
    hooks: {},
    record: () => storage.has(KEY) ? JSON.parse(storage.get(KEY)) : null,
    count: name => calls.filter(call => call.name === name).length,
    events: name => calls.filter(call => call.name === name),
    login(user) { session.generation = `${user}-login-${++sequence}`; session.tokens = user ? { accessToken: `${user}-access`, refreshToken: `${user}-refresh` } : null; },
    fire(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms === ms) { timers.delete(id); timer.callback(); }
      }
    },
  };
  if (options.shared) Object.defineProperty(h, 'sub', {
    get: () => options.shared.sub,
    set: value => { options.shared.sub = value; },
  });
  const invoke = async (name, args, fallback) => {
    calls.push({ name, args: clone(args) });
    return h.hooks[name] ? h.hooks[name](...args) : fallback();
  };
  h.makeSub = (endpoint = ENDPOINT, publicKey = PUBLIC_KEY) => {
    const sub = {
      endpoint,
      options: { applicationServerKey: Uint8Array.from(Buffer.from(publicKey, 'base64')).buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } }),
      unsubscribe: () => invoke('browser.unsubscribe', [endpoint], () => {
        if (h.sub === sub) h.sub = null;
        return true;
      }),
    };
    return sub;
  };
  if (options.subscription !== false && !h.sub) h.sub = h.makeSub();
  const pushManager = {
    getSubscription: () => invoke('browser.get', [], () => h.sub),
    subscribe: init => invoke('browser.subscribe', [init], () => {
      const key = Buffer.from(init.applicationServerKey).toString('base64');
      h.sub = h.makeSub(`https://push.example.test/device-${++sequence}`, key);
      return h.sub;
    }),
  };
  class ApiRequestError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  h.ApiRequestError = ApiRequestError;
  const tokenStore = {
    generation: () => session.generation,
    isCurrent: expected => session.generation === expected,
    get: () => session.tokens,
  };
  const notification = {
    get permission() { return h.permission; },
    requestPermission() {
      calls.push({ name: 'permission', args: [] });
      const pending = h.hooks.permission ? h.hooks.permission() : Promise.resolve(h.permissionResult);
      return pending.then(value => { h.permission = value; return value; });
    },
  };
  const api = {
    config: () => invoke('api.config', [], () => h.config),
    subscribe: body => invoke('api.subscribe', [body], () => ({ device: 'fake-device' })),
    unsubscribe: endpoint => invoke('api.unsubscribe', [endpoint], () => ({ removed: true })),
    settings() { assert.fail('Device lifecycle must not read per-space settings'); },
    updateSettings() { assert.fail('Device lifecycle must not mutate per-space settings'); },
  };
  const exports = {};
  const navigator = { serviceWorker: { ready: Promise.resolve({ pushManager }) }, locks: options.shared?.locks };
  h.navigator = navigator;
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === '../../lib/tokenStore') return { tokenStore };
      if (name === '../../lib/apiClient') return { ApiRequestError, assertCurrentSession(expected) {
        if (!tokenStore.isCurrent(expected)) throw new ApiRequestError(409, 'SESSION_CHANGED', 'session changed');
      } };
      if (name === '../../lib/installPrompt') return { detectDevice: () => ({ platform: options.platform ?? 'android' }), isStandalone: () => options.standalone ?? true };
      if (name === './api') return { pushApi: api };
      if (name === './onboardingPolicy') return { setPushExplicitlyOff: userId => calls.push({ name: 'policy.off', args: [userId] }) };
      throw new Error(`Unexpected import ${name}`);
    },
    window: {
      PushManager: function PushManager() {}, Notification: notification,
      setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    navigator, Notification: notification, AbortController,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    Date: class extends Date { static now() { return h.now; } },
    fetch: (url, init) => invoke('fetch', [url, { ...init, body: JSON.parse(init.body) }], () => ({ ok: true, status: 200 })),
  }, { filename });
  h.device = exports;
  return h;
}

// Independent VM modules share only origin-wide browser state, session and a FIFO Web Lock.
function sharedOrigin() {
  let queue = Promise.resolve();
  const origin = {
    storage: new Map(), sub: null, lockNames: [],
    session: { generation: 'alice-login', tokens: { accessToken: 'alice-access', refreshToken: 'alice-refresh' } },
    locks: {
      request(name, callback) {
        origin.lockNames.push(name);
        const next = queue.then(() => callback({ name, mode: 'exclusive' }));
        queue = next.catch(() => undefined);
        return next;
      },
    },
  };
  return origin;
}

// No space argument or settings API participates in a device opt-in.
test('one explicit enable serves both spaces of the same account; sync does not reprompt or duplicate', async () => {
  const h = harness({ subscription: false, permission: 'default' });
  const enabling = h.device.enableOnThisDevice('alice');
  assert.equal(h.count('permission'), 1, 'permission must be requested in the original tap stack');
  await enabling;
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  assert.equal(await h.device.readDeviceState('bob'), 'off');
  assert.deepEqual(h.record(), record({ endpoint: h.sub.endpoint }));
  assert.deepEqual(h.events('api.subscribe')[0].args[0], {
    endpoint: h.sub.endpoint, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' },
  });
  await h.device.syncThisDevice('alice'); // couple view
  await h.device.syncThisDevice('alice'); // friends view
  assert.equal(h.count('api.subscribe'), 1);
  assert.equal(h.count('browser.subscribe'), 1);
  assert.equal(h.count('permission'), 1);
  h.now += 12 * 3_600_000;
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('api.subscribe'), 2);
  assert.equal(h.record().syncedAt, h.now);
});

for (const space of ['couple', 'friends']) {
  test(`legacy ${space} same-user consent migrates once despite recent sync throttle`, async () => {
    const legacy = { userId: 'alice', endpoint: ENDPOINT, syncedAt: NOW, space };
    const h = harness({ record: legacy });
    await h.device.syncThisDevice('alice');
    assert.deepEqual(h.record(), record());
    await h.device.syncThisDevice('alice');
    assert.equal(h.count('api.subscribe'), 1);
    assert.equal(h.count('browser.subscribe'), 0);
    assert.equal(h.count('permission'), 0);
  });
}

for (const setup of [
  { label: 'missing record' },
  { label: 'malformed record', rawRecord: '{broken' },
  { label: 'unversioned record without legacy space', record: { userId: 'alice', endpoint: ENDPOINT } },
  { label: 'different account', record: record({ userId: 'bob' }) },
  { label: 'different legacy account', record: { userId: 'bob', endpoint: ENDPOINT, space: 'friends' } },
]) {
  test(`${setup.label} never implicitly enables even when browser permission is granted`, async () => {
    const h = harness(setup);
    assert.equal(await h.device.readDeviceState('alice'), 'off');
    await h.device.syncThisDevice('alice');
    assert.equal(h.sub, null, 'unowned browser delivery must be disabled');
    assert.equal(h.count('api.subscribe'), 0);
    assert.equal(h.count('api.unsubscribe'), 0, 'never remove another account using the current credentials');
    assert.equal(h.count('permission'), 0);
    assert.equal(await h.device.readDeviceState('alice'), 'off');
  });
}

for (const permission of ['default', 'denied']) {
  test(`lost ${permission} permission clears existing opt-in and server/browser subscription`, async () => {
    const h = harness({ record: record(), permission });
    await h.device.syncThisDevice('alice');
    assert.equal(h.record(), null);
    assert.equal(h.sub, null);
    assert.deepEqual(h.events('api.unsubscribe').map(call => call.args), [[ENDPOINT]]);
    assert.equal(h.count('permission'), 0);
    assert.equal(await h.device.readDeviceState('alice'), permission === 'denied' ? 'denied' : 'off');
  });
}

test('lost browser subscription removes stale server registration without creating a replacement', async () => {
  const h = harness({ record: record(), subscription: false });
  await h.device.syncThisDevice('alice');
  assert.equal(h.record(), null);
  assert.equal(h.count('api.unsubscribe'), 1);
  assert.equal(h.count('browser.subscribe'), 0);
  assert.equal(h.count('api.subscribe'), 0);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
});

for (const permission of ['denied', 'default']) {
  test(`explicit permission result ${permission} fails without recording consent`, async () => {
    const h = harness({ subscription: false, permission: 'default', permissionResult: permission });
    await assert.rejects(h.device.enableOnThisDevice('alice'), { code: permission === 'denied' ? 'denied' : 'dismissed' });
    assert.equal(h.record(), null);
    assert.equal(h.count('api.config'), 0);
    assert.equal(await h.device.readDeviceState('alice'), permission === 'denied' ? 'denied' : 'off');
  });
}

test('VAPID rotation removes stale consent but never enrolls from background sync', async () => {
  const h = harness({ record: record() });
  h.config.publicKey = ROTATED_KEY;
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('browser.unsubscribe'), 1);
  assert.equal(h.count('browser.subscribe'), 0);
  assert.equal(h.count('api.subscribe'), 0);
  assert.deepEqual(h.events('api.unsubscribe')[0].args, [ENDPOINT]);
  assert.equal(h.sub, null);
  assert.equal(h.record(), null);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('browser.subscribe'), 0);
  assert.equal(h.count('policy.off'), 0, 'repair is not an explicit opt-out');
  await h.device.enableOnThisDevice('alice');
  assert.equal(h.count('browser.subscribe'), 1);
  assert.equal(await h.device.readDeviceState('alice'), 'on');
});

test('config network failure preserves healthy opt-in and can retry', async () => {
  const h = harness({ record: record({ syncedAt: 0 }) });
  h.hooks['api.config'] = () => Promise.reject(new Error('offline'));
  await h.device.syncThisDevice('alice');
  assert.deepEqual(h.record(), record({ syncedAt: 0 }));
  assert.equal(h.count('browser.unsubscribe'), 0);
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  delete h.hooks['api.config'];
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('api.subscribe'), 1);
});

test('temporary service worker failure preserves consent rather than interpreting it as a lost subscription', async () => {
  const h = harness({ record: record() });
  h.hooks['browser.get'] = () => Promise.reject(new Error('worker restarting'));
  await h.device.syncThisDevice('alice');
  assert.deepEqual(h.record(), record());
  assert.equal(h.count('api.unsubscribe'), 0);
  assert.equal(h.count('browser.unsubscribe'), 0);
  delete h.hooks['browser.get'];
  assert.equal(await h.device.readDeviceState('alice'), 'on');
});

test('enable registration error leaves no consent, and next explicit enable recovers the queue', async () => {
  const h = harness({ subscription: false });
  h.hooks['api.subscribe'] = () => Promise.reject(new Error('offline'));
  await assert.rejects(h.device.enableOnThisDevice('alice'), /offline/);
  assert.equal(h.record(), null);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
  delete h.hooks['api.subscribe'];
  await h.device.enableOnThisDevice('alice');
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  assert.equal(h.count('browser.subscribe'), 1, 'a valid existing browser endpoint can be retried');
});

test('BAD_ENDPOINT on explicit enable drops unusable browser endpoint and stays off', async () => {
  const h = harness({ subscription: false });
  h.hooks['api.subscribe'] = () => Promise.reject(new h.ApiRequestError(400, 'BAD_ENDPOINT', 'invalid endpoint'));
  await assert.rejects(h.device.enableOnThisDevice('alice'), { code: 'BAD_ENDPOINT' });
  assert.equal(h.record(), null);
  assert.equal(h.sub, null);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
});

test('failed sync preserves timestamp for retry instead of throttling a failed server write', async () => {
  const h = harness({ record: record({ syncedAt: 0 }) });
  h.hooks['api.subscribe'] = () => Promise.reject(new Error('offline'));
  await assert.rejects(h.device.syncThisDevice('alice'), /offline/);
  assert.equal(h.record().syncedAt, 0);
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  delete h.hooks['api.subscribe'];
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('api.subscribe'), 2);
  assert.equal(h.record().syncedAt, NOW);
});

test('explicit rotation followed by failed registration remains off and retries only by tap', async () => {
  const h = harness({ record: record() });
  h.config.publicKey = ROTATED_KEY;
  h.hooks['api.subscribe'] = () => Promise.reject(new Error('offline'));
  await assert.rejects(h.device.enableOnThisDevice('alice'), /offline/);
  assert.equal(h.record().endpoint, ENDPOINT);
  assert.notEqual(h.sub.endpoint, ENDPOINT);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
  delete h.hooks['api.subscribe'];
  await h.device.enableOnThisDevice('alice');
  assert.equal(h.record().endpoint, h.sub.endpoint);
  assert.equal(await h.device.readDeviceState('alice'), 'on');
});

test('overlapping syncs serialize and register a stale device only once', async () => {
  const h = harness({ record: record({ syncedAt: 0 }) });
  const gate = deferred();
  h.hooks['api.subscribe'] = () => gate.promise;
  const first = h.device.syncThisDevice('alice');
  const second = h.device.syncThisDevice('alice');
  await until(() => h.count('api.subscribe') === 1);
  assert.equal(h.count('api.config'), 1);
  gate.resolve({ device: 'fake-device' });
  await Promise.all([first, second]);
  assert.equal(h.count('api.subscribe'), 1);
  assert.equal(h.record().syncedAt, NOW);
});

for (const operation of ['enable', 'sync']) {
  for (const boundary of ['api.config', 'api.subscribe']) {
    for (const action of ['disable', 'logout', 'new account', 'new enable']) {
      test(`delayed ${operation} at ${boundary} cannot outlive ${action}`, async () => {
        const h = harness({ record: operation === 'sync' ? record({ syncedAt: 0 }) : undefined });
        const gate = deferred();
        let firstCall = true;
        h.hooks[boundary] = () => {
          if (firstCall) { firstCall = false; return gate.promise; }
          return boundary === 'api.config' ? h.config : { device: 'fake-device' };
        };
        const old = settle(operation === 'enable' ? h.device.enableOnThisDevice('alice') : h.device.syncThisDevice('alice'));
        await until(() => h.count(boundary) === 1);
        let newer;
        if (action === 'disable') {
          newer = h.device.disableOnThisDevice();
          assert.equal(h.record(), null, 'disable clears consent synchronously');
        } else if (action === 'logout') {
          newer = h.device.forgetThisDevice('alice-access');
          h.login(null);
          assert.equal(h.record(), null, 'logout clears consent synchronously');
        } else if (action === 'new account') {
          h.login('bob');
          newer = h.device.syncThisDevice('bob');
        } else {
          newer = h.device.enableOnThisDevice('alice');
        }
        gate.resolve(boundary === 'api.config' ? h.config : { device: 'fake-device' });
        const result = await old;
        assert.equal(result.error?.code, action === 'logout' || action === 'new account' ? 'SESSION_CHANGED' : 'PUSH_CHANGED');
        await newer;
        if (action === 'new enable') {
          assert.equal(await h.device.readDeviceState('alice'), 'on');
          assert.equal(h.record().userId, 'alice');
        } else {
          assert.equal(h.record(), null);
          assert.equal(h.sub, null);
          assert.equal(await h.device.readDeviceState(action === 'new account' ? 'bob' : 'alice'), 'off');
        }
        if (action === 'logout') {
          assert.equal(h.events('fetch')[0].args[1].headers.Authorization, 'Bearer alice-access');
        }
      });
    }
  }
}

test('delayed permission result cannot resurrect a disabled device', async () => {
  const h = harness({ subscription: false, permission: 'default' });
  const gate = deferred();
  h.hooks.permission = () => gate.promise;
  const old = settle(h.device.enableOnThisDevice('alice'));
  const disabling = h.device.disableOnThisDevice();
  gate.resolve('granted');
  assert.equal((await old).error?.code, 'PUSH_CHANGED');
  await disabling;
  assert.equal(h.count('api.subscribe'), 0);
  assert.equal(h.record(), null);
});

test('browser subscribe resolving after disable is cleaned before the disable completes', async () => {
  const h = harness({ subscription: false });
  const gate = deferred();
  h.hooks['browser.subscribe'] = () => gate.promise;
  const old = settle(h.device.enableOnThisDevice('alice'));
  await until(() => h.count('browser.subscribe') === 1);
  const disabling = h.device.disableOnThisDevice();
  h.sub = h.makeSub();
  gate.resolve(h.sub);
  assert.equal((await old).error?.code, 'PUSH_CHANGED');
  await disabling;
  assert.equal(h.sub, null);
  assert.equal(h.record(), null);
  assert.equal(h.count('api.subscribe'), 0);
});

test('delayed disable DELETE cannot unsubscribe a newer enable', async () => {
  const h = harness({ record: record() });
  const gate = deferred();
  h.hooks.fetch = () => gate.promise;
  const old = settle(h.device.disableOnThisDevice());
  await until(() => h.count('fetch') === 1);
  const enabling = h.device.enableOnThisDevice('alice');
  assert.equal(h.count('api.subscribe'), 0, 'new registration must wait for old DELETE');
  gate.resolve({ ok: true });
  assert.equal((await old).error?.code, 'PUSH_CHANGED');
  await enabling;
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  assert.equal(h.count('browser.unsubscribe'), 0);
});

test('logout cleanup retains old credentials and precedes a new account explicit enable', async () => {
  const h = harness({ record: record() });
  const gate = deferred();
  h.hooks.fetch = () => gate.promise;
  const forgetting = h.device.forgetThisDevice('alice-access');
  await until(() => h.count('fetch') === 1);
  h.login('bob');
  const enabling = h.device.enableOnThisDevice('bob');
  assert.equal(h.count('api.subscribe'), 0);
  gate.resolve({ ok: true });
  await Promise.all([forgetting, enabling]);
  assert.equal(h.events('fetch')[0].args[1].headers.Authorization, 'Bearer alice-access');
  assert.equal(h.record().userId, 'bob');
  assert.equal(await h.device.readDeviceState('bob'), 'on');
  assert.equal(await h.device.readDeviceState('alice'), 'off');
});

test('logout during explicit rotation removes the actual newly registered endpoint, not just the stale record', async () => {
  const h = harness({ record: record() });
  h.config.publicKey = ROTATED_KEY;
  const gate = deferred();
  h.hooks['api.subscribe'] = () => gate.promise;
  const old = settle(h.device.enableOnThisDevice('alice'));
  await until(() => h.count('api.subscribe') === 1);
  const rotatedEndpoint = h.sub.endpoint;
  assert.notEqual(rotatedEndpoint, ENDPOINT);
  const forgetting = h.device.forgetThisDevice('alice-access');
  h.login(null);
  gate.resolve({ device: 'fake-device' });
  assert.equal((await old).error?.code, 'SESSION_CHANGED');
  await forgetting;
  assert.equal(h.record(), null);
  assert.equal(h.sub, null, 'logout must unsubscribe the rotated browser endpoint even though storage still points at the old endpoint');
  assert.ok(h.events('fetch').some(call => call.args[1].body.endpoint === rotatedEndpoint), 'logout must delete the rotated endpoint registered by the late POST');
});

test('timed-out initial subscribe cleans a late orphan without recording consent', async () => {
  const h = harness({ subscription: false });
  const gate = deferred();
  h.hooks['browser.subscribe'] = () => gate.promise;
  const enabling = settle(h.device.enableOnThisDevice('alice'));
  await until(() => h.count('browser.subscribe') === 1 && [...h.timers.values()].some(timer => timer.ms === 45_000));
  h.fire(45_000);
  assert.match((await enabling).error.message, /timeout/);
  h.sub = h.makeSub();
  gate.resolve(h.sub);
  await until(() => h.count('browser.unsubscribe') === 1);
  assert.equal(h.sub, null);
  assert.equal(h.record(), null);
  assert.equal(h.count('api.subscribe'), 0);
});

test('late timed-out subscription cannot unsubscribe a newer enable still waiting for config', async () => {
  const h = harness({ subscription: false });
  const browserGate = deferred();
  h.hooks['browser.subscribe'] = () => browserGate.promise;
  const old = settle(h.device.enableOnThisDevice('alice'));
  await until(() => h.count('browser.subscribe') === 1 && [...h.timers.values()].some(timer => timer.ms === 45_000));
  h.fire(45_000);
  assert.match((await old).error.message, /timeout/);
  const configGate = deferred();
  h.hooks['api.config'] = () => configGate.promise;
  const newer = h.device.enableOnThisDevice('alice');
  await until(() => h.count('api.config') === 2);
  h.sub = h.makeSub();
  const lateSub = h.sub;
  browserGate.resolve(lateSub);
  // Let the late cleanup callback run while the new enable still owns the mutation queue.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(h.count('browser.unsubscribe'), 0);
  configGate.resolve(h.config);
  await newer;
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(h.sub, lateSub);
  assert.equal(h.count('browser.unsubscribe'), 0);
  assert.equal(await h.device.readDeviceState('alice'), 'on');
});

test('disable still clears browser consent when server cleanup fails', async () => {
  const h = harness({ record: record() });
  h.hooks.fetch = () => Promise.reject(new Error('offline'));
  await h.device.disableOnThisDevice();
  assert.equal(h.record(), null);
  assert.equal(h.sub, null);
  assert.equal(await h.device.readDeviceState('alice'), 'off');
});

test('unanswered permission prompt does not delay logout cleanup or hold the shared Web Lock', async () => {
  const origin = sharedOrigin();
  const h = harness({ shared: origin, record: record(), permission: 'default' });
  const permission = deferred();
  h.hooks.permission = () => permission.promise;
  const old = settle(h.device.enableOnThisDevice('alice'));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(origin.lockNames.length, 0, 'OS permission wait must stay outside the mutation lock');
  let finished = false;
  const forgetting = h.device.forgetThisDevice('alice-access').then(() => { finished = true; });
  h.login(null);
  await until(() => finished);
  assert.equal(h.sub, null);
  assert.equal(h.record(), null);
  assert.equal(h.count('fetch'), 1);
  assert.equal(h.count('api.config'), 0);
  permission.resolve('granted');
  assert.equal((await old).error?.code, 'SESSION_CHANGED');
  await forgetting;
  assert.equal(h.count('api.subscribe'), 0);
});

test('enable getSubscription has a bounded wait and releases mutation queue after timeout', async () => {
  const h = harness({ subscription: false });
  const browser = deferred();
  h.hooks['browser.get'] = () => browser.promise;
  let result;
  const pending = settle(h.device.enableOnThisDevice('alice')).then(value => { result = value; return value; });
  await until(() => h.count('browser.get') === 1);
  assert.ok([...h.timers.values()].some(timer => timer.ms === 8_000), 'getSubscription must have its own deadline');
  h.fire(8_000);
  await until(() => result !== undefined);
  assert.match(result.error?.message, /timeout/);
  assert.equal(h.record(), null);
  delete h.hooks['browser.get'];
  await h.device.enableOnThisDevice('alice');
  assert.equal(await h.device.readDeviceState('alice'), 'on');
  browser.resolve(null);
  await pending;
  assert.equal(h.count('api.subscribe'), 1, 'late timed-out read cannot continue the old enable');
});

test('two VM tabs serialize logout DELETE before new-account enable using shared Web Lock', async () => {
  const origin = sharedOrigin();
  const oldTab = harness({ shared: origin, record: record() });
  const newTab = harness({ shared: origin });
  const deletion = deferred();
  oldTab.hooks.fetch = () => deletion.promise;
  const forgetting = oldTab.device.forgetThisDevice('alice-access');
  oldTab.login(null);
  await until(() => oldTab.count('fetch') === 1);
  newTab.login('bob');
  const enabling = newTab.device.enableOnThisDevice('bob');
  await until(() => origin.lockNames.length === 2);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(newTab.count('api.config'), 0, 'new tab cannot mutate before old DELETE finishes');
  assert.equal(newTab.count('api.subscribe'), 0);
  deletion.resolve({ ok: true });
  await Promise.all([forgetting, enabling]);
  assert.deepEqual(origin.lockNames, [KEY, KEY]);
  assert.equal(oldTab.events('fetch')[0].args[1].headers.Authorization, 'Bearer alice-access');
  assert.equal(oldTab.count('browser.unsubscribe'), 0, 'new login protects reusable browser subscription');
  assert.equal(newTab.record().userId, 'bob');
  assert.equal(await newTab.device.readDeviceState('bob'), 'on');
  assert.equal(await oldTab.device.readDeviceState('bob'), 'on');
});

test('two VM tabs skip stale logout cleanup when newer enable publishes before logout acquires lock', async () => {
  const origin = sharedOrigin();
  const oldTab = harness({ shared: origin, record: record() });
  const newTab = harness({ shared: origin });
  newTab.login('bob');
  const registration = deferred();
  newTab.hooks['api.subscribe'] = () => registration.promise;
  const enabling = newTab.device.enableOnThisDevice('bob');
  await until(() => newTab.count('api.subscribe') === 1);
  const forgetting = oldTab.device.forgetThisDevice('alice-access');
  await until(() => origin.lockNames.length === 2);
  assert.equal(newTab.record(), null, 'logout clears old record before waiting for the lock');
  registration.resolve({ device: 'bob-device' });
  await Promise.all([enabling, forgetting]);
  assert.equal(newTab.record().userId, 'bob');
  assert.equal(oldTab.count('fetch'), 0, 'cleanup must not DELETE the freshly owned endpoint');
  assert.equal(oldTab.count('browser.unsubscribe'), 0);
  assert.equal(await newTab.device.readDeviceState('bob'), 'on');
});

test('two VM tabs logout still removes browser delivery when no replacement login exists', async () => {
  const origin = sharedOrigin();
  const first = harness({ shared: origin, record: record() });
  const second = harness({ shared: origin });
  const forgetting = first.device.forgetThisDevice('alice-access');
  second.login(null);
  await forgetting;
  assert.equal(second.record(), null);
  assert.equal(second.sub, null);
  assert.equal(await second.device.readDeviceState('alice'), 'off');
  assert.deepEqual(origin.lockNames, [KEY]);
});

test('state notifications reflect successful enable and immediate disable; removed listeners stay removed', async () => {
  const h = harness({ subscription: false });
  let notices = 0;
  const unsubscribe = h.device.subscribeDevice(() => { notices += 1; });
  await h.device.enableOnThisDevice('alice');
  assert.equal(notices, 1);
  assert.equal(h.device.deviceVersion(), 1);
  const disabling = h.device.disableOnThisDevice();
  assert.equal(notices, 2);
  unsubscribe();
  await disabling;
  assert.equal(notices, 2);
  assert.equal(h.device.deviceVersion(), 3);
});

test('stale tap guard runs synchronously before OS permission or device work', async () => {
  const h = harness({ permission: 'default', subscription: false });
  let checked = 0;
  const pending = h.device.enableOnThisDevice('alice', () => {
    checked++;
    throw new h.ApiRequestError(409, 'ACCESS_CHANGED', 'locked');
  });
  assert.equal(checked, 1);
  assert.equal(h.calls.length, 0);
  await assert.rejects(pending, { code: 'ACCESS_CHANGED' });
});

for (const boundary of ['permission', 'api.config', 'browser.get', 'browser.subscribe', 'api.subscribe']) {
  test(`caller access guard cancels explicit enable after ${boundary}`, async () => {
    const h = harness({ permission: 'default', subscription: false });
    const gate = deferred();
    let allowed = true;
    h.hooks[boundary] = () => gate.promise;
    const old = settle(h.device.enableOnThisDevice('alice', () => {
      if (!allowed) throw new h.ApiRequestError(409, 'ACCESS_CHANGED', 'locked');
    }));
    await until(() => h.count(boundary) === 1);
    allowed = false;
    if (boundary === 'browser.subscribe') h.sub = h.makeSub();
    gate.resolve(boundary === 'permission' ? 'granted' : boundary === 'api.config' ? h.config : boundary === 'browser.subscribe' ? h.sub : null);
    assert.equal((await old).error?.code, 'ACCESS_CHANGED');
    assert.equal(h.record(), null);
    assert.equal(h.sub, null, 'late-created subscription must not survive access loss');
    assert.equal(h.count('api.subscribe'), boundary === 'api.subscribe' ? 1 : 0);
    if (boundary === 'api.subscribe') {
      assert.equal(h.events('fetch')[0].args[1].headers.Authorization, 'Bearer alice-access');
    }
  });
}

test('guard-failed late browser subscription preserves a newer published owner', async () => {
  const h = harness({ subscription: false });
  const gate = deferred();
  let allowed = true;
  h.hooks['browser.subscribe'] = () => gate.promise;
  const old = settle(h.device.enableOnThisDevice('alice', () => { if (!allowed) throw Error('stale'); }));
  await until(() => h.count('browser.subscribe') === 1);
  allowed = false;
  h.sub = h.makeSub();
  h.storage.set(KEY, JSON.stringify(record({ userId: 'bob' })));
  gate.resolve(h.sub);
  assert.match((await old).error.message, /stale/);
  assert.equal(h.count('browser.unsubscribe'), 0);
  assert.equal(h.record().userId, 'bob');
});

test('only explicit disable records opt-out, including when a device record is missing', async () => {
  const h = harness({ record: record() });
  await h.device.forgetThisDevice();
  await h.device.syncThisDevice('alice');
  assert.equal(h.count('policy.off'), 0);
  await h.device.disableOnThisDevice('alice');
  assert.deepEqual(h.events('policy.off').map(call => call.args), [['alice']]);
});

test('sync access guard stops before config and never enrolls a mismatched endpoint', async () => {
  const h = harness({ record: record() });
  const gate = deferred();
  let allowed = true;
  h.hooks['browser.get'] = () => gate.promise;
  const old = settle(h.device.syncThisDevice('alice', () => { if (!allowed) throw Error('locked'); }));
  await until(() => h.count('browser.get') === 1);
  allowed = false; gate.resolve(h.sub);
  assert.match((await old).error.message, /locked/);
  assert.equal(h.count('api.config'), 0);
  delete h.hooks['browser.get'];
  h.sub = h.makeSub('https://push.example.test/unowned');
  await h.device.syncThisDevice('alice');
  assert.equal(h.record(), null);
  assert.equal(h.count('browser.subscribe'), 0);
  assert.equal(h.count('api.subscribe'), 0);
});
