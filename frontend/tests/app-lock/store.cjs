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
function fixture({ space = 'couple', generation = 'session-a', token = 'token-a', epoch = 0, visibility = 'visible' } = {}) {
  const clock = { wall: 1_700_000_000_000, monotonic: 123_000 };
  class ClockDate extends Date { static now() { return clock.wall; } }
  class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
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
    activeElement: null, title: '', visibilityState: visibility,
    querySelector: selector => selector === 'meta[name="theme-color"]' ? themeMeta : null,
    querySelectorAll: selector => { assert.equal(selector, 'video,audio'); return [video, audio]; },
    addEventListener: (type, fn) => add(documentListeners, type, fn),
    dispatchEvent: event => dispatch(documentListeners, event.type, event),
  };
  const window = {
    addEventListener: (type, fn) => add(windowListeners, type, fn),
    dispatchEvent: event => dispatch(windowListeners, event.type, event),
  };
  const current = { generation, space, token };
  const tokenStore = { get: () => current.token, generation: () => current.generation, isCurrent: value => value === current.generation, isSessionKey: key => key === 'session' };
  const spaceStore = { get: () => current.space, isSpaceKey: key => key === 'space' };
  const requests = [], modalPauses = [], writes = [], accessEpochs = [];
  function apiRequest(url, options) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ url, options, resolve, reject });
    return promise;
  }
  const globals = { window, document, location: { pathname: '/' }, HTMLElement: Element, HTMLMediaElement: Media, MutationObserver: Observer,
    Date: ClockDate, performance: { now: () => clock.monotonic }, Event, CustomEvent,
    localStorage: { setItem: (key, value) => writes.push([key, value]) }, crypto: { randomUUID: () => 'nonce' } };
  const bootstrapFile = path.resolve(source, '../../../public/app-lock-bootstrap.js');
  vm.runInNewContext(fs.readFileSync(bootstrapFile, 'utf8'), globals, { filename: bootstrapFile });
  window.__lwAppLock.epoch = epoch;
  const mask = load('mask.ts', { '../../hooks/useModal': { setModalPrivacyPause: value => modalPauses.push(value) } }, globals);
  const store = load('store.ts', { '../../lib/apiClient': { apiRequest, advanceAccessEpoch: () => accessEpochs.push(accessEpochs.length + 1) }, '../../lib/tokenStore': { tokenStore }, '../../lib/spaceStore': { spaceStore }, './mask': mask }, globals);
  store.activateAppLock();
  return {
    store, mask, current, clock, document, window, root, app, entry, bootstrap, script, video, audio, themeMeta, modalPauses, writes, requests, accessEpochs, Element, Media,
    advance: (wall, monotonic = wall) => { clock.wall += wall; clock.monotonic += monotonic; },
    respond: async value => { const req = requests.shift(); assert.ok(req, 'expected a pending request'); req.resolve(value); await Promise.resolve(); await Promise.resolve(); },
    reject: async error => { const req = requests.shift(); assert.ok(req, 'expected a pending request'); req.reject(error); await Promise.resolve(); await Promise.resolve(); },
    storage: key => dispatch(windowListeners, 'storage', { key }),
    // Low-level invalidation is retained for old race tests. Lifecycle tests below
    // drive actual bootstrap listeners, including CustomEvent reason forwarding.
    conceal: () => window.dispatchEvent(new CustomEvent('lw:app-lock', { detail: 'hidden' })),
    hide: () => { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    visible: () => { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
    pagehide: () => window.dispatchEvent(new Event('pagehide')),
    pageshow: (persisted = true) => window.dispatchEvent(new Event('pageshow', { persisted })),
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
async function verified(f, config = status(true, true), method = 'pin') {
  if (method === 'password') {
    f.store.bindPasswordLogin(f.current.space, f.store.appLockEpoch());
    await initial(f, config);
  } else {
    await initial(f, config);
    const pending = f.store.unlockApp('1234');
    await f.respond({ space: f.current.space, revision: config.revision });
    assert.equal(await pending, f.current.space);
    assert.equal(f.store.appLockState().phase, 'opening');
    f.store.finishAppUnlock();
  }
  assert.equal(f.store.appLockState().phase, 'ready');
  assert.equal(f.store.appLockState().discard, false);
  f.store.appLockSurfaceReady();
}
function concealed(f, discard = false) {
  assert.equal(f.store.isAppLocked(), true);
  assert.equal(f.store.appLockState().discard, discard);
  assert.equal(f.mask.isAppMasked(), true);
  hidden(f.app);
}

for (const method of ['pin', 'password']) for (const space of ['couple', 'friends']) {
  test(`${method} verified ${space} resumes under 10000ms only after current status`, async () => {
    const f = fixture({ space }); await verified(f, status(true, true), method);
    f.store.setAppTitle('Private draft'); f.store.setAppTheme(true);
    const portal = new f.Element('DIV', 'draft-portal'); f.append(portal);
    f.document.activeElement = portal;
    const epoch = f.store.appLockEpoch();
    // Grace starts on departure, not on login or the last PIN verification.
    f.advance(60_000); f.hide();
    assert.equal(f.store.appLockState().phase, 'concealed'); concealed(f);
    hidden(portal); assert.ok(portal.blurCount > 0);
    assert.equal(f.root.getAttribute('data-app-shield'), '');
    assert.equal(f.document.title, 'Love Within');
    assert.equal(f.root.dataset.theme, undefined); assert.equal(f.themeMeta.content, '#faf7f8');
    assert.equal(f.store.appLockEpoch(), epoch + 1);
    assert.equal(f.accessEpochs.length, 1, 'hide invalidates in-flight API access even without discarding');
    assert.equal(f.store.isAppLockCurrent(epoch), false);
    assert.equal(f.video.pauseCount > 0, true);
    f.advance(9_999); f.visible(); concealed(f);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/privacy-lock');
    f.store.appLockSurfaceReady(); concealed(f);
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, 'ready');
    assert.equal(f.store.appLockState().discard, false); assert.equal(f.mask.isAppMasked(), false);
    assert.equal(f.app.style.getPropertyValue('display'), '');
    assert.equal(portal.style.getPropertyValue('display'), '');
    assert.equal(f.document.title, 'Private draft'); assert.equal(f.root.dataset.theme, 'friends');
    assert.equal(f.writes.length, 0, 'grace must remain in memory, never browser storage');
  });
}

for (const elapsed of [10_000, 10_001, 60_000]) {
  test(`verified resume at ${elapsed}ms discards before status and requires PIN`, async () => {
    const f = fixture(); await verified(f);
    f.hide(); concealed(f); f.advance(elapsed); f.visible(); concealed(f, true);
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
  });
}

test('grace is checked again when status completes, not just when resume starts', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.advance(9_999); f.visible(); concealed(f);
  f.advance(1); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

for (const [wall, monotonic] of [[10_000, 1], [1, 10_000], [-1, 1], [1, -1], [NaN, 1], [1, Infinity]]) {
  test(`clock divergence fails closed: wall=${wall}, monotonic=${monotonic}`, async () => {
    const f = fixture(); await verified(f);
    f.hide(); f.advance(wall, monotonic); f.visible(); concealed(f, true);
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, 'locked');
  });
}

for (const elapsed of [9_999, 10_000]) {
  test(`repeated hide/pagehide preserve original ${elapsed}ms deadline`, async () => {
    const f = fixture(); await verified(f);
    f.hide(); f.advance(4_000); f.pagehide(); f.hide();
    concealed(f); f.advance(4_000); f.pagehide();
    assert.equal(f.requests.length, 0, 'departure cannot revalidate or reveal');
    f.advance(elapsed - 8_000); f.visible();
    concealed(f, elapsed >= 10_000);
    const old = f.requests.shift(); assert.ok(old);
    f.visible(); assert.equal(f.requests.length, 1);
    old.resolve(status(false, false)); await Promise.resolve(); await Promise.resolve();
    concealed(f, elapsed >= 10_000);
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, elapsed < 10_000 ? 'ready' : 'locked');
    assert.equal(f.store.appLockState().discard, elapsed >= 10_000);
  });
}

for (const hiddenRestore of [false, true]) {
  test(`persisted restore revokes even an unexpired grant (hidden=${hiddenRestore})`, async () => {
    const f = fixture(); await verified(f);
    f.hide(); f.advance(1); f.pagehide();
    if (!hiddenRestore) f.document.visibilityState = 'visible';
    f.pageshow(); concealed(f, true);
    if (hiddenRestore) { assert.equal(f.requests.length, 0); f.visible(); }
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
  });
}

for (const failure of [false, true]) {
  test(`successful PIN supersedes an older status ${failure ? 'error' : 'response'}`, async () => {
    const f = fixture(); await initial(f, status(true, true));
    const refresh = f.store.refreshLockSettings(false); const older = f.requests.shift();
    const unlock = f.store.unlockApp('1234');
    await f.respond({ space: 'couple', revision: 1 }); assert.equal(await unlock, 'couple');
    f.store.finishAppUnlock();
    if (failure) older.reject(new Error('ACCESS_CHANGED'));
    else older.resolve(status(true, true, 2));
    await refresh;
    assert.equal(f.store.appLockState().phase, 'ready'); assert.equal(f.store.appLockState().discard, false);
    assert.equal(f.store.appLockState().settings.revision, 1);
  });
}

test('second absence after a successful revalidation gets its own deadline', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.advance(9_000); f.visible(); await f.respond(status(true, true));
  f.advance(60_000); f.hide(); f.advance(9_999); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'ready'); assert.equal(f.store.appLockState().discard, false);
});

test('persisted restore without a recorded departure cannot invent grace', async () => {
  const f = fixture(); await verified(f);
  f.pageshow(false); assert.equal(f.requests.length, 0);
  f.pageshow(); concealed(f, true); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked');
});

test('reload uses only credentials and space, never the preceding memory grant', async () => {
  const previous = fixture({ space: 'friends' }); await verified(previous);
  previous.hide(); previous.advance(1);
  const f = fixture({ ...previous.current });
  concealed(f, true); await initial(f, status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked');
  f.hide(); f.advance(1); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

test('incomplete PIN opening has no ready grant to retain', async () => {
  const f = fixture(); await initial(f, status(true, true));
  const pending = f.store.unlockApp('1234'); await f.respond({ space: 'couple', revision: 1 }); await pending;
  assert.equal(f.store.appLockState().phase, 'opening');
  f.hide(); f.store.finishAppUnlock(); concealed(f, true);
  f.advance(1); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked');
});

test('changed settings revision revokes a short-resume grant', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.advance(1); f.visible(); concealed(f);
  await f.respond(status(true, true, 2));
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

for (const change of ['settings', 'session', 'space', 'reset', 'navigation']) {
  test(`${change} invalidation cannot reuse a pending short-resume grant`, async () => {
    const f = fixture(); await verified(f);
    f.hide(); f.advance(1); f.visible(); const stale = f.requests.shift();
    if (change === 'settings') f.storage('lw.lockSettingsChanged');
    if (change === 'session') { f.current.generation = 'session-b'; f.storage('session'); }
    if (change === 'space') { f.current.space = 'friends'; f.storage('space'); }
    if (change === 'reset') { f.store.resetAppLock(); void f.store.refreshLockSettings(false); }
    if (change === 'navigation') f.store.lockForNavigation();
    concealed(f, true);
    stale.resolve(status(false, false)); await Promise.resolve(); await Promise.resolve(); concealed(f, true);
    await f.respond(status(true, true));
    assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
  });
}

test('same-generation token rotation retains the short-resume grant', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.current.token = 'rotated'; f.storage('session');
  f.advance(100); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'ready'); assert.equal(f.store.appLockState().discard, false);
});

test('offline short resume discards protected state and retry cannot revive the grant', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.advance(1); f.visible(); await f.reject(new Error('offline'));
  assert.equal(f.store.appLockState().phase, 'error'); concealed(f, true);
  const retry = f.store.refreshLockSettings(); await f.respond(status(true, true)); await retry;
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

test('status completing hidden cannot reveal and a later resume rechecks the original deadline', async () => {
  const f = fixture(); await verified(f);
  f.hide(); f.advance(1); f.visible();
  // Simulate a delayed visibility event: response cannot rely only on event epochs.
  f.document.visibilityState = 'hidden'; await f.respond(status(true, true)); concealed(f);
  f.advance(9_999); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

test('cold status completing hidden never creates an authenticated entry', async () => {
  const f = fixture({ visibility: 'hidden' }); await initial(f, status(true, true)); concealed(f, true);
  f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked'); concealed(f, true);
});

test('real hide invalidates stale PIN and status responses before short resume', async () => {
  const f = fixture(); await initial(f, status(true, true));
  const unlock = f.store.unlockApp('1234'); const staleUnlock = f.requests.shift();
  const refresh = f.store.refreshLockSettings(false); const staleStatus = f.requests.shift();
  f.hide(); f.advance(1); f.visible();
  staleUnlock.resolve({ space: 'couple', revision: 1 });
  staleStatus.resolve(status(false, false)); await refresh;
  assert.equal(await unlock, null); concealed(f, true);
  await f.respond(status(true, true)); assert.equal(f.store.appLockState().phase, 'locked');
});

test('short-resume completion does not clear an independent verification mask', async () => {
  const f = fixture(); await verified(f);
  const host = new f.Element('DIV', 'verification'); f.append(host); f.mask.setVerificationHost(host);
  f.mask.setAppMask('verification', true); hidden(f.app);
  f.hide(); hidden(host); f.advance(1); f.visible(); await f.respond(status(true, true));
  assert.equal(f.store.appLockState().phase, 'ready'); assert.equal(f.store.appLockState().discard, false);
  assert.equal(f.mask.isAppMasked(), true); hidden(f.app);
  assert.equal(host.style.getPropertyValue('display'), '');
  const pauses = f.video.pauseCount; f.play(f.video); assert.equal(f.video.pauseCount, pauses + 1);
  f.mask.setAppMask('verification', false);
  assert.equal(f.mask.isAppMasked(), false); assert.equal(f.app.style.getPropertyValue('display'), '');
});

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
  f.hide(); f.advance(10_000); f.visible();
  assert.equal(f.store.appLockState().discard, true);
  await f.respond(status(true, false, 2)); assert.equal(f.store.appLockState().phase, 'locked');
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

test('leaving the personal shell makes stored credentials inert until reactivation', async () => {
  const f = fixture();
  const deactivate = f.store.activateAppLock();
  await verified(f);
  const pending = f.store.refreshLockSettings(false);
  const stale = f.requests.shift();
  deactivate();
  assert.equal(f.current.token, 'token-a', 'admin does not erase the stored account token');
  assert.equal(f.mask.isAppMasked(), false);
  f.hide(); f.visible(); f.pageshow();
  f.storage('lw.lockSettingsChanged');
  f.current.generation = 'other-tab'; f.storage('session');
  f.current.space = 'friends'; f.storage('space');
  await f.store.refreshLockSettings(false);
  assert.equal(f.requests.length, 0, 'no personal queries from admin lifecycle events');
  stale.resolve(status(true, true)); await pending;
  assert.equal(f.mask.isAppMasked(), false, 'a late personal response cannot mask the admin shell');
  const stop = f.store.activateAppLock();
  assert.equal(f.store.appLockState().phase, 'loading');
  await initial(f, status(true, true));
  assert.equal(f.store.appLockState().phase, 'locked', 'return to personal shell cannot reuse earlier PIN entry');
  stop();
});

test('media is paused on masking and play while either reason remains', () => {
  const f = fixture({ token: null }); f.play(f.video); assert.equal(f.video.pauseCount, 0);
  f.mask.setAppMask('lock', true); assert.equal(f.video.pauseCount, 1); assert.equal(f.audio.pauseCount, 1);
  f.play(f.video); assert.equal(f.video.pauseCount, 2);
  f.mask.setAppMask('verification', true); f.mask.setAppMask('lock', false);
  const prior = f.audio.pauseCount; f.play(f.audio); assert.equal(f.audio.pauseCount, prior + 1);
  f.mask.setAppMask('verification', false); f.play(f.audio); assert.equal(f.audio.pauseCount, prior + 1);
});
