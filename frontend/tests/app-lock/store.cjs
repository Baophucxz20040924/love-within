'use strict';

// Run with node --test frontend/tests/app-lock/store.cjs. APP_LOCK_SOURCE_ROOT
// may point at another frontend/src/features/appLock directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// This suite is developed in a git worktree while the controller is developed
// in the primary checkout. No project module other than TypeScript is loaded.
const primary = path.resolve(__dirname, '../../../../../..');
const localSource = path.resolve(__dirname, '../../src/features/appLock');
const source = process.env.APP_LOCK_SOURCE_ROOT || (fs.existsSync(localSource) ? localSource : path.join(primary, 'frontend/src/features/appLock'));
const ts = require(require.resolve('typescript', { paths: [__dirname, path.resolve(source, '../../..'), path.join(primary, 'frontend')] }));
function load(file, mocks, globals) {
  const filename = path.join(source, file);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    ...globals, module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name} in ${file}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}
function fixture({ space = 'couple', generation = 'session-a', token = 'token-a', epoch = 0 } = {}) {
  const windowListeners = new Map(), documentListeners = new Map();
  const add = (map, type, fn) => { if (!map.has(type)) map.set(type, []); map.get(type).push(fn); };
  const dispatch = (map, type, event = {}) => { for (const fn of map.get(type) || []) fn(event); };
  class Element {
    constructor(tagName = 'DIV', id = '') {
      this.tagName = tagName; this.id = id; this.inert = false; this.attrs = new Map(); this.values = new Map(); this.blurCount = 0;
      this.style = {
        getPropertyValue: key => this.values.get(key)?.[0] ?? '',
        getPropertyPriority: key => this.values.get(key)?.[1] ?? '',
        setProperty: (key, value, priority = '') => this.values.set(key, [value, priority]),
        removeProperty: key => this.values.delete(key),
      };
    }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }
    removeAttribute(key) { this.attrs.delete(key); }
    blur() { this.blurCount++; }
  }
  class Media extends Element { constructor(tag = 'VIDEO') { super(tag); this.pauseCount = 0; } pause() { this.pauseCount++; } }
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; this.connected = false; }
    observe(body, options) { assert.equal(body, document.body); assert.equal(options.childList, true); this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const root = new Element('HTML'); root.dataset = {}; root.setAttribute('data-app-shield', '');
  const app = new Element('DIV', 'root'), entry = new Element('DIV', 'app-lock-entry');
  const bootstrap = new Element('DIV', 'app-lock-bootstrap'), script = new Element('SCRIPT');
  const video = new Media(), audio = new Media('AUDIO'), themeMeta = { content: '' };
  const document = {
    body: { children: [app, entry, bootstrap, script] }, documentElement: root,
    activeElement: null, title: '', visibilityState: 'visible',
    querySelector: selector => selector === 'meta[name="theme-color"]' ? themeMeta : null,
    querySelectorAll: selector => { assert.equal(selector, 'video,audio'); return [video, audio]; },
    addEventListener: (type, fn) => add(documentListeners, type, fn),
  };
  const window = { __lwAppLock: { epoch, protected: Boolean(token) }, addEventListener: (type, fn) => add(windowListeners, type, fn) };
  const current = { generation, space, token };
  const tokenStore = { get: () => current.token, generation: () => current.generation, isCurrent: value => value === current.generation, isSessionKey: key => key === 'session' };
  const spaceStore = { get: () => current.space, isSpaceKey: key => key === 'space' };
  const requests = [], modalPauses = [], writes = [];
  function apiRequest(url, options) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ url, options, resolve, reject });
    return promise;
  }
  const globals = { window, document, location: { pathname: '/' }, HTMLElement: Element, HTMLMediaElement: Media, MutationObserver: Observer,
    localStorage: { setItem: (key, value) => writes.push([key, value]) }, crypto: { randomUUID: () => 'nonce' } };
  const mask = load('mask.ts', { '../../hooks/useModal': { setModalPrivacyPause: value => modalPauses.push(value) } }, globals);
  const store = load('store.ts', { '../../lib/apiClient': { apiRequest }, '../../lib/tokenStore': { tokenStore }, '../../lib/spaceStore': { spaceStore }, './mask': mask }, globals);
  return {
    store, mask, current, document, window, root, app, entry, bootstrap, script, video, audio, themeMeta, modalPauses, writes, requests, Element, Media,
    respond: async value => { const req = requests.shift(); assert.ok(req, 'expected a pending request'); req.resolve(value); await Promise.resolve(); await Promise.resolve(); },
    reject: async error => { const req = requests.shift(); assert.ok(req, 'expected a pending request'); req.reject(error); await Promise.resolve(); await Promise.resolve(); },
    storage: key => dispatch(windowListeners, 'storage', { key }),
    conceal: () => dispatch(windowListeners, 'lw:app-lock'),
    visible: () => { document.visibilityState = 'visible'; dispatch(documentListeners, 'visibilitychange'); },
    play: target => dispatch(documentListeners, 'play', { target }),
    append: node => { document.body.children.push(node); if (observer?.connected) observer.callback(); },
  };
}
function hidden(node) {
  assert.equal(node.style.getPropertyValue('display'), 'none');
  assert.equal(node.style.getPropertyPriority('display'), 'important');
  assert.equal(node.inert, true); assert.equal(node.getAttribute('aria-hidden'), 'true');
}
const status = (couple, friends, revision = 1) => ({ couple, friends, revision });
async function initial(f, config) { const pending = f.store.refreshLockSettings(); await f.respond(config); await pending; }

for (const couple of [false, true]) for (const friends of [false, true]) for (const space of ['couple', 'friends']) {
  test(`cold and resume: couple=${couple} friends=${friends} space=${space}`, async () => {
    const f = fixture({ space }), config = status(couple, friends);
    assert.equal(f.store.appLockState().phase, 'loading'); hidden(f.app);
    await initial(f, config);
    assert.equal(f.store.appLockState().phase, config[space] ? 'locked' : 'ready');
    assert.equal(f.store.appLockState().discard, config[space]);
    f.document.visibilityState = 'hidden'; f.conceal();
    assert.equal(f.store.appLockState().discard, config[space], 'an unprotected space must retain its mounted state');
    f.visible(); await f.respond(config);
    assert.equal(f.store.appLockState().phase, config[space] ? 'locked' : 'ready');
    assert.equal(f.store.appLockState().discard, config[space]);
  });
}

test('PIN lock remains closed until the server authorizes the requested space', async () => {
  const f = fixture(); await initial(f, status(true, true));
  f.store.finishAppUnlock(); assert.equal(f.store.appLockState().phase, 'locked');
  const pending = f.store.unlockApp('1234');
  assert.equal(f.requests[0].url, '/privacy-lock/unlock');
  assert.equal(f.requests[0].options.method, 'POST');
  assert.equal(f.store.appLockState().phase, 'locked'); hidden(f.app);
  await f.respond({ space: 'friends', revision: 1 });
  assert.equal(await pending, 'friends'); assert.equal(f.store.appLockState().phase, 'opening'); hidden(f.app);
  f.store.finishAppUnlock(); assert.equal(f.store.appLockState().phase, 'ready');
});

for (const change of ['epoch', 'generation']) {
  test(`late unlock cannot authorize after ${change} changes`, async () => {
    const f = fixture(); await initial(f, status(true, true));
    const pending = f.store.unlockApp('1234');
    if (change === 'epoch') f.conceal(); else f.current.generation = 'session-b';
    await f.respond({ space: 'friends', revision: 1 });
    assert.equal(await pending, null); assert.notEqual(f.store.appLockState().phase, 'opening'); hidden(f.app);
  });
}

test('wrong revision cannot unlock and forces a fresh configuration check', async () => {
  const f = fixture(); await initial(f, status(true, true));
  const pending = f.store.unlockApp('1234'); await f.respond({ space: 'couple', revision: 2 });
  assert.equal(f.store.appLockState().phase, 'locked'); assert.equal(f.requests[0].url, '/privacy-lock');
  await f.respond(status(true, true, 2)); assert.equal(await pending, null); assert.equal(f.store.appLockState().phase, 'locked');
});

test('unlock cannot use a stale revision after concurrent status refresh', async () => {
  const f = fixture(); await initial(f, status(true, true, 1));
  const unlock = f.store.unlockApp('1234');
  const pendingStatus = f.store.refreshLockSettings(false);
  const oldUnlock = f.requests.shift();
  await f.respond(status(true, true, 2)); await pendingStatus;
  oldUnlock.resolve({ space: 'couple', revision: 1 });
  assert.equal(await unlock, null);
  assert.equal(f.store.appLockState().phase, 'locked'); hidden(f.app);
});

test('unlock cannot enter a disabled target even with matching revision', async () => {
  const f = fixture({ space: 'couple' }); await initial(f, status(true, false));
  const pending = f.store.unlockApp('1234'); await f.respond({ space: 'friends', revision: 1 });
  assert.equal(await pending, null); assert.equal(f.store.appLockState().phase, 'locked'); hidden(f.app);
});

test('password grant is consumed and cannot bypass a newer configuration revision', async () => {
  const f = fixture();
  f.store.bindPasswordLogin('couple', f.store.appLockEpoch());
  await initial(f, status(true, false, 1)); assert.equal(f.store.appLockState().phase, 'ready');
  const pending = f.store.refreshLockSettings(); await f.respond(status(true, false, 2)); await pending;
  assert.equal(f.store.appLockState().phase, 'locked'); hidden(f.app);
});

test('cross-tab atomic logout clears the lock and does not request settings', () => {
  const f = fixture();
  f.current.generation = 'logout-generation'; f.current.token = null;
  f.storage('session');
  assert.equal(f.store.appLockState().phase, 'ready');
  assert.equal(f.store.appLockState().discard, false);
  assert.equal(f.window.__lwAppLock.protected, false);
  assert.equal(f.requests.length, 0);
});

test('unlock rejection leaves the neutral lock screen', async () => {
  const f = fixture(); await initial(f, status(true, false));
  f.store.setAppTitle('Private title'); f.store.setAppTheme(true);
  const pending = f.store.unlockApp('1234');
  const outcome = pending.then(() => null, error => error);
  await f.reject(new Error('wrong PIN'));
  assert.equal((await outcome).message, 'wrong PIN');
  assert.equal(f.store.appLockState().phase, 'locked');
  assert.equal(f.document.title, 'Love Within');
  assert.equal(f.root.dataset.theme, undefined);
  assert.equal(f.themeMeta.content, '#faf7f8'); hidden(f.app);
});

test('malformed unlock responses never grant entry', async () => {
  for (const response of [undefined, null, { space: 'elsewhere', revision: 1 }]) {
    const f = fixture(); await initial(f, status(true, true));
    const pending = f.store.unlockApp('1234');
    // Attach the rejection handler before resolving: malformed responses may be
    // reported as an error or as a null result, but must never grant entry.
    const outcome = pending.then(value => value, () => null);
    await f.respond(response);
    assert.equal(await outcome, null); assert.equal(f.store.appLockState().phase, 'locked'); hidden(f.app);
  }
});

for (const change of ['epoch', 'generation']) {
  test(`late status cannot authorize after ${change} changes`, async () => {
    const f = fixture(); const pending = f.store.refreshLockSettings();
    if (change === 'epoch') f.conceal(); else f.current.generation = 'session-b';
    await f.respond(status(false, false)); await pending;
    assert.notEqual(f.store.appLockState().phase, 'ready'); hidden(f.app);
  });
}

test('same generation token rotation does not invalidate a ready session', async () => {
  const f = fixture(); await initial(f, status(false, true));
  const epoch = f.store.appLockEpoch(); f.current.token = 'rotated'; f.storage('session');
  assert.equal(f.store.appLockEpoch(), epoch); assert.equal(f.store.appLockState().phase, 'ready');
  assert.equal(f.store.appLockState().discard, false);
});

test('own configuration update publishes and subsequent resume enforces it', async () => {
  const f = fixture(); await initial(f, status(false, false));
  f.store.applyOwnLockSettings(status(true, false, 2));
  assert.equal(f.store.appLockState().settings.revision, 2);
  assert.equal(f.store.appLockState().phase, 'ready');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0], 'lw.lockSettingsChanged');
  f.conceal(); assert.equal(f.store.appLockState().phase, 'locked');
  f.visible(); await f.respond(status(true, false, 2)); assert.equal(f.store.appLockState().phase, 'locked');
});

test('missing or invalid status is an error, never an unprotected grant', async () => {
  for (const response of [undefined, null, {}, { couple: false, friends: false }, { couple: false, friends: false, revision: '1' }, { couple: 0, friends: false, revision: 1 }, { couple: false, friends: false, revision: -1 }, { couple: false, friends: false, revision: 1.5 }, { couple: false, friends: false, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(); await initial(f, response);
    assert.equal(f.store.appLockState().phase, 'error'); hidden(f.app);
  }
});

test('failed status remains error and concealed', async () => {
  const f = fixture(); const pending = f.store.refreshLockSettings(); await f.reject(new Error('offline')); await pending;
  assert.equal(f.store.appLockState().phase, 'error'); hidden(f.app);
});

for (const firstClear of ['lock', 'verification']) {
  test(`independent masks and late portals when ${firstClear} clears first`, () => {
    const f = fixture({ token: null });
    const host = new f.Element('DIV', 'verification'), portal = new f.Element('DIV', 'portal');
    portal.style.setProperty('display', 'grid', 'important'); portal.inert = true; portal.setAttribute('aria-hidden', 'false');
    f.append(host); f.append(portal); f.mask.setVerificationHost(host); f.document.activeElement = portal;
    f.mask.setAppMask('verification', true); hidden(f.app); hidden(portal); assert.equal(portal.blurCount, 1);
    assert.equal(host.style.getPropertyValue('display'), '');
    f.mask.setAppMask('lock', true); hidden(host); assert.equal(f.entry.style.getPropertyValue('display'), '');
    const late = new f.Element('DIV', 'late'); f.append(late); hidden(late);
    f.mask.setAppMask(firstClear, false); assert.equal(f.mask.isAppMasked(), true); hidden(f.app); hidden(portal); hidden(late);
    if (firstClear === 'lock') { assert.equal(host.style.getPropertyValue('display'), ''); hidden(f.entry); }
    else { hidden(host); assert.equal(f.entry.style.getPropertyValue('display'), ''); }
    const later = new f.Element('DIV', 'later'); f.append(later); hidden(later);
    f.mask.setAppMask(firstClear === 'lock' ? 'verification' : 'lock', false);
    assert.equal(f.mask.isAppMasked(), false); assert.equal(f.root.getAttribute('data-app-mask'), null);
    assert.equal(f.modalPauses.at(-1), false); assert.equal(portal.style.getPropertyValue('display'), 'grid');
    assert.equal(portal.style.getPropertyPriority('display'), 'important'); assert.equal(portal.inert, true); assert.equal(portal.getAttribute('aria-hidden'), 'false');
    for (const node of [f.app, host, late, later]) { assert.equal(node.style.getPropertyValue('display'), ''); assert.equal(node.inert, false); assert.equal(node.getAttribute('aria-hidden'), null); }
  });
}

test('media is paused on masking and play while either reason remains', () => {
  const f = fixture({ token: null }); f.play(f.video); assert.equal(f.video.pauseCount, 0);
  f.mask.setAppMask('lock', true); assert.equal(f.video.pauseCount, 1); assert.equal(f.audio.pauseCount, 1);
  f.play(f.video); assert.equal(f.video.pauseCount, 2);
  f.mask.setAppMask('verification', true); f.mask.setAppMask('lock', false);
  const prior = f.audio.pauseCount; f.play(f.audio); assert.equal(f.audio.pauseCount, prior + 1);
  f.mask.setAppMask('verification', false); f.play(f.audio); assert.equal(f.audio.pauseCount, prior + 1);
});
