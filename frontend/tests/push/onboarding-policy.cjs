const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('../../node_modules/typescript');

// Execute the real policy in isolated documents sharing only mocked browser facilities.
const filename = path.join(__dirname, '../../src/features/push/onboardingPolicy.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = 'lw.push.onboarding.v1.';
const keyOf = user => `${PREFIX}${encodeURIComponent(user)}`;

function origin() {
  let queue = Promise.resolve();
  const shared = {
    storage: new Map(), windows: new Set(), lockNames: [], held: 0,
    locks: {
      request(name, callback) {
        shared.lockNames.push(name);
        const next = queue.then(async () => {
          shared.held += 1;
          try { return await callback({ name, mode: 'exclusive' }); }
          finally { shared.held -= 1; }
        });
        queue = next.catch(() => undefined);
        return next;
      },
    },
  };
  return shared;
}

function harness(options = {}) {
  const shared = options.shared ?? origin();
  const listeners = new Set();
  const h = {
    shared, now: options.now ?? NOW, reads: 0, writes: 0, deniedRead: !!options.deniedRead,
    deniedWrite: !!options.deniedWrite, listeners,
    record: (user = 'alice') => JSON.parse(shared.storage.get(keyOf(user)) ?? 'null'),
    event(event) { for (const listener of listeners) listener(event); },
  };
  shared.windows.add(h);
  const storage = {
    getItem(key) {
      h.reads += 1;
      if (h.deniedRead) throw new Error('storage denied');
      return shared.storage.get(key) ?? null;
    },
    setItem(key, value) {
      h.writes += 1;
      if (h.deniedWrite) throw new Error('quota/storage denied');
      shared.storage.set(key, value);
      // Real storage events arrive in other documents, not the writing document.
      queueMicrotask(() => {
        for (const peer of shared.windows) if (peer !== h) peer.event({ key });
      });
    },
  };
  const exports = {};
  const context = {
    exports, Date: class extends Date { static now() { return h.now; } },
    require(name) { assert.fail(`Policy must not import consent/network/auth dependencies: ${name}`); },
  };
  if (!options.noBrowser) {
    context.window = { addEventListener(name, listener) { assert.equal(name, 'storage'); listeners.add(listener); } };
    context.localStorage = storage;
    context.navigator = { locks: options.noLocks ? undefined : options.locks ?? shared.locks };
  }
  vm.runInNewContext(compiled, context, { filename });
  h.policy = exports;
  return h;
}

async function claim(h, generation = 'login-1', permission = 'default', user = 'alice') {
  return h.policy.claimOnboarding(user, generation, permission);
}
function finish(h, reason, generation = 'login-1', user = 'alice') {
  h.policy.finishOnboarding(user, generation, reason);
}

test('legacy suggestion respects denied help without suppressing a later permission change', async () => {
  const h = harness();
  assert.equal(await claim(h, 'denied-login', 'denied'), true);
  finish(h, 'denied', 'denied-login');
  assert.equal(h.policy.canSuggestPush('alice', 'denied'), false);
  assert.equal(h.policy.canSuggestPush('alice', 'default'), true);
  assert.equal(h.policy.canSuggestPush('alice', 'granted'), true);
  assert.equal(h.policy.canSuggestPush('bob', 'denied'), true);
});

test('imports have no browser/storage side effects; read-only arbitration does not consume opportunity', async () => {
  const h = harness();
  assert.equal(h.reads, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.policy.onboardingVersion(), 0);
  for (let i = 0; i < 3; i += 1) assert.equal(h.policy.canSuggestPush('alice'), true);
  assert.equal(h.writes, 0);
  assert.equal(h.listeners.size, 1);
  assert.equal(await claim(h), true);
  assert.equal(h.policy.canSuggestPush('alice'), false);
  assert.equal(await claim(h), false);
  assert.equal(await claim(h, 'another-login'), false);
  assert.equal(h.shared.held, 0, 'reservation releases lock before presentation finishes');
  finish(h, 'interrupted');
  assert.equal(h.policy.canSuggestPush('alice'), true);
  assert.equal(await claim(h), false, 'remount/space/focus must not create another presentation');
  assert.equal(await claim(h, 'another-login'), true);
});

for (const [reason, duration] of [['later', 7 * DAY], ['failure', DAY]]) {
  test(`${reason} suppresses future logins and old card for exactly ${duration / DAY} days`, async () => {
    const h = harness();
    assert.equal(await claim(h), true);
    finish(h, reason);
    assert.equal(h.record().cooldownUntil, NOW + duration);
    h.now += duration - 1;
    assert.equal(h.policy.canSuggestPush('alice'), false);
    assert.equal(await claim(h, 'login-2'), false);
    h.now += 1;
    assert.equal(h.policy.canSuggestPush('alice'), true);
    assert.equal(await claim(h), false, 'expiry does not reset consumed generation');
    assert.equal(await claim(h, 'login-2'), true, 'blocked attempt did not consume generation');
  });
}

for (const reason of ['interrupted', 'unavailable', 'success']) {
  test(`${reason} releases active card without a timed cooldown; reload still consumes generation`, async () => {
    const h = harness();
    assert.equal(await claim(h), true);
    finish(h, reason);
    assert.equal(h.policy.canSuggestPush('alice'), true);
    const reload = harness({ shared: h.shared });
    assert.equal(await claim(reload), false);
    assert.equal(await claim(reload, 'login-2'), true);
  });
}

test('all already-consumed identities remain consumed in document across newer presentations', async () => {
  const h = harness();
  for (const generation of ['login-1', 'login-2', 'login-3']) {
    assert.equal(await claim(h, generation), true);
    finish(h, 'interrupted', generation);
  }
  for (const generation of ['login-1', 'login-2', 'login-3']) assert.equal(await claim(h, generation), false);
});

test('explicit off is indefinite, account-scoped, persists, and only successful manual enable clears it', async () => {
  const h = harness();
  assert.equal(await claim(h), true);
  h.policy.setPushExplicitlyOff('alice');
  finish(h, 'success'); // stale success is not a successful manual enable
  assert.equal(h.policy.isPushExplicitlyOff('alice'), true);
  h.now += 365 * DAY;
  assert.equal(await claim(h, 'login-2'), false);
  assert.equal(h.policy.canSuggestPush('alice'), false);
  assert.equal(h.policy.canSuggestPush('bob'), true);
  const reload = harness({ shared: h.shared, now: h.now });
  assert.equal(reload.policy.isPushExplicitlyOff('alice'), true);
  assert.equal(await claim(reload, 'login-2'), false);
  reload.policy.recordPushEnabled('alice');
  assert.equal(reload.policy.isPushExplicitlyOff('alice'), false);
  assert.equal(reload.policy.canSuggestPush('alice'), true);
  assert.equal(await claim(reload), false, 'manual enable must not resurrect the consumed login');
  assert.equal(await claim(reload, 'login-2', 'granted'), true);
});

test('manual enable clears cooldown and denied-help suppression without requiring an active claim', async () => {
  const h = harness();
  assert.equal(await claim(h, 'login-1', 'denied'), true);
  finish(h, 'later');
  assert.equal(h.record().deniedHelpShown, true);
  h.policy.recordPushEnabled('alice');
  assert.equal(h.record().cooldownUntil, 0);
  assert.equal(h.record().deniedHelpShown, false);
  assert.equal(h.record().permission, 'granted');
  assert.equal(await claim(h, 'login-2', 'granted'), true);
});

for (const reason of ['denied', 'interrupted', 'unavailable', 'later']) {
  test(`denied help finished as ${reason} is shown once until an observed permission change`, async () => {
    const h = harness();
    assert.equal(await claim(h, 'login-1', 'denied'), true);
    finish(h, reason);
    h.now += 8 * DAY;
    assert.equal(await claim(h, 'login-2', 'denied'), false);
    const reload = harness({ shared: h.shared, now: h.now });
    assert.equal(await claim(reload, 'login-2', 'denied'), false);
    assert.equal(await claim(reload, 'login-2', 'default'), true);
    finish(reload, 'interrupted', 'login-2');
    assert.equal(await claim(reload, 'login-3', 'denied'), true);
  });
}

test('a newly denied permission result also records denied history', async () => {
  const h = harness();
  assert.equal(await claim(h), true);
  finish(h, 'denied');
  assert.equal(await claim(h, 'login-2', 'denied'), false);
  assert.equal(await claim(h, 'login-2', 'granted'), true);
});

test('permission change resets denied history even on an already consumed generation', async () => {
  const h = harness();
  assert.equal(await claim(h, 'login-1', 'denied'), true);
  finish(h, 'denied');
  assert.equal(await claim(h, 'login-1', 'default'), false);
  assert.equal(await claim(h, 'login-2', 'denied'), true);
});

for (const options of [{ deniedRead: true, deniedWrite: true }, { deniedWrite: true }, { noBrowser: true }]) {
  test(`memory-first behavior survives unavailable storage/browser ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal(await claim(h), true);
    finish(h, 'later');
    assert.equal(await claim(h, 'login-2'), false);
    assert.equal(h.policy.canSuggestPush('alice'), false);
    h.now += 7 * DAY;
    assert.equal(await claim(h), false);
    h.policy.setPushExplicitlyOff('alice');
    assert.equal(h.policy.isPushExplicitlyOff('alice'), true);
    h.policy.recordPushEnabled('alice');
    assert.equal(h.policy.isPushExplicitlyOff('alice'), false);
    assert.equal(await claim(h, 'login-2'), true);
  });
}

test('failed storage write never allows a stale persisted choice to undo a newer local choice', async () => {
  const h = harness();
  h.policy.setPushExplicitlyOff('alice');
  h.deniedWrite = true;
  h.policy.recordPushEnabled('alice');
  assert.equal(h.record().explicitlyOff, true);
  assert.equal(h.policy.isPushExplicitlyOff('alice'), false);
  h.event({ key: keyOf('alice') });
  assert.equal(h.policy.isPushExplicitlyOff('alice'), false);
  h.deniedWrite = false;
  assert.equal(await claim(h), true);
  assert.equal(h.record().explicitlyOff, false);
});

test('same-account cross-tab claims serialize, notify observers, and never hold lock for UI', async () => {
  const shared = origin();
  const a = harness({ shared });
  const b = harness({ shared });
  let notices = 0;
  b.policy.subscribeOnboarding(() => { notices += 1; });
  const results = await Promise.all([claim(a), claim(b)]);
  assert.deepEqual(results, [true, false]);
  assert.equal(b.policy.canSuggestPush('alice'), false);
  assert.ok(notices > 0);
  assert.equal(shared.held, 0);
  finish(b, 'later');
  assert.equal(a.record().cooldownUntil, 0, 'unowned finish must be inert');
  finish(a, 'interrupted');
  assert.equal(b.policy.canSuggestPush('alice'), true);
  assert.equal(await claim(b), false);
  assert.equal(await claim(b, 'login-2'), true);
  assert.ok(shared.lockNames.every(name => name === keyOf('alice')));
});

test('another-tab manual off invalidates local claim and stale completion', async () => {
  const shared = origin();
  const a = harness({ shared });
  const b = harness({ shared });
  assert.equal(await claim(a), true);
  b.policy.setPushExplicitlyOff('alice');
  finish(a, 'success');
  assert.equal(a.policy.isPushExplicitlyOff('alice'), true);
  assert.equal(b.policy.isPushExplicitlyOff('alice'), true);
});

test('stale finish cannot release a newer generation or impose a cooldown', async () => {
  const h = harness();
  assert.equal(await claim(h), true);
  finish(h, 'interrupted');
  assert.equal(await claim(h, 'login-2'), true);
  finish(h, 'later');
  assert.equal(h.record().active.generation, 'login-2');
  assert.equal(h.record().cooldownUntil, 0);
});

test('queued claims cannot outlive manual off or enable', async () => {
  for (const action of ['setPushExplicitlyOff', 'recordPushEnabled']) {
    let run;
    const h = harness({ locks: { request(_name, callback) { return new Promise(resolve => { run = () => resolve(callback()); }); } } });
    const pending = claim(h);
    h.policy[action]('alice');
    run();
    assert.equal(await pending, false);
    assert.equal(h.record().active, null);
  }
});

test('Web Lock access rejection falls back to local reservation; absent locks remain usable', async () => {
  for (const options of [{ noLocks: true }, { locks: { request() { return Promise.reject(new Error('not allowed')); } } }]) {
    const h = harness(options);
    assert.equal(await claim(h), true);
    assert.equal(await claim(h), false);
    finish(h, 'interrupted');
    assert.equal(await claim(h, 'login-2'), true);
  }
});

test('local active remains reserved; crashed-tab lease expires but consumed generation survives', async () => {
  const shared = origin();
  const a = harness({ shared });
  assert.equal(await claim(a), true);
  a.now += 6 * 60 * 1000;
  assert.equal(a.policy.canSuggestPush('alice'), false, 'live presentation still owns local reservation');
  const reload = harness({ shared, now: a.now });
  assert.equal(reload.policy.canSuggestPush('alice'), true, 'crashed-tab reservation is bounded');
  assert.equal(await claim(reload), false);
  assert.equal(await claim(reload, 'login-2'), true);
  finish(a, 'later');
  assert.equal(reload.record().active.generation, 'login-2');
  assert.equal(reload.record().cooldownUntil, 0);
});

test('account keys are encoded and generations store no auth credentials or consent record', async () => {
  const h = harness();
  const user = 'alice / + % @ example';
  assert.equal(await claim(h, 'opaque-login-identity', 'default', user), true);
  assert.deepEqual([...h.shared.storage.keys()], [keyOf(user)]);
  const persisted = h.shared.storage.get(keyOf(user));
  assert.equal(JSON.parse(persisted).consumedGeneration, 'opaque-login-identity');
  assert.doesNotMatch(persisted, /accessToken|refreshToken|endpoint|subscription/);
  assert.equal(await claim(h, 'opaque-login-identity', 'default', 'bob'), true);
});

test('malformed, unknown-version, and invalid typed persisted fields are ignored', async () => {
  for (const raw of ['{broken', 'null', '[]', '{"version":99,"explicitlyOff":true}', JSON.stringify({
    version: 1, explicitlyOff: 'true', cooldownUntil: '9999999999999999',
    deniedHelpShown: 'true', permission: 'denied', consumedGeneration: {}, active: { until: 1e300 },
  })]) {
    const shared = origin();
    shared.storage.set(keyOf('alice'), raw);
    const h = harness({ shared });
    assert.equal(h.policy.canSuggestPush('alice'), true);
    assert.equal(await claim(h), true);
  }
});

test('non-finite/negative timestamps are ignored and excessive future deadlines are clamped', async () => {
  for (const rawUntil of ['1e999', '-1', 'null']) {
    const shared = origin();
    shared.storage.set(keyOf('alice'), `{"version":1,"cooldownUntil":${rawUntil}}`);
    assert.equal(harness({ shared }).policy.canSuggestPush('alice'), true);
  }
  const shared = origin();
  shared.storage.set(keyOf('alice'), JSON.stringify({
    version: 1, cooldownUntil: 1e300,
    active: { owner: 'old-tab', generation: 'old-login', permission: 'default', until: 1e300 },
  }));
  const h = harness({ shared });
  assert.equal(h.policy.canSuggestPush('alice'), false);
  h.now += 7 * DAY;
  assert.equal(h.policy.canSuggestPush('alice'), true, 'unchanged corrupt storage must not extend the clamped deadline');
  assert.equal(await claim(h), true);
});

test('storage changes refresh lazily loaded accounts; unrelated keys and removed subscribers are ignored', () => {
  const h = harness();
  let notices = 0;
  const unsubscribe = h.policy.subscribeOnboarding(() => { notices += 1; });
  assert.equal(h.policy.canSuggestPush('alice'), true);
  h.event({ key: 'lw.push.device' });
  assert.equal(notices, 0);
  h.shared.storage.set(keyOf('alice'), JSON.stringify({ version: 1, explicitlyOff: true }));
  h.event({ key: keyOf('alice') });
  assert.equal(notices, 1);
  assert.equal(h.policy.onboardingVersion(), 1);
  assert.equal(h.policy.canSuggestPush('alice'), false);
  h.shared.storage.clear();
  h.event({ key: null });
  assert.equal(h.policy.canSuggestPush('alice'), true);
  unsubscribe();
  h.policy.setPushExplicitlyOff('alice');
  assert.equal(notices, 2);
  assert.equal(h.policy.onboardingVersion(), 3);
  assert.equal(h.listeners.size, 1, 'one lazy document listener, not one per component');
});

test('invalid identities or permission never create reservations', async () => {
  const h = harness();
  assert.equal(await claim(h, '', 'default'), false);
  assert.equal(await claim(h, 'login-1', 'unknown'), false);
  assert.equal(await claim(h, 'login-1', 'default', ''), false);
  assert.equal(h.policy.canSuggestPush(''), false);
  h.policy.setPushExplicitlyOff('');
  h.policy.recordPushEnabled('');
  assert.equal(h.shared.storage.size, 0);
});
