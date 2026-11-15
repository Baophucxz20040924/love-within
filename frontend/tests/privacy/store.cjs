'use strict';

// Run with: node --test frontend/tests/privacy/store.cjs
// Each case gets fresh module instances, DOM, bootstrap state and stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    try { return require(require.resolve('typescript', { paths: [dir] })); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
const source = process.env.PRIVACY_SOURCE_ROOT || path.resolve(__dirname, '../../src/features/privacy');
function load(file, mocks, globals) {
  const filename = path.join(source, file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    ...globals, module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name} in ${file}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

function fixture({ space = 'couple', pathname = '/', generation = 'session-a', epoch = 0 } = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const add = (listeners, type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const dispatch = (listeners, type, event = {}) => {
    for (const fn of listeners.get(type) || []) fn(event);
  };
  class Element {
    constructor(tagName = 'DIV', id = '') {
      this.tagName = tagName;
      this.id = id;
      this.inert = false;
      this.attrs = new Map();
      this.values = new Map();
      this.blurCount = 0;
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
  class Media extends Element {
    constructor(tagName = 'VIDEO') { super(tagName); this.pauseCount = 0; }
    pause() { this.pauseCount++; }
  }
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; this.connected = false; observer = this; }
    observe(body, options) { assert.equal(body, document.body); assert.equal(options.childList, true); this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const root = new Element('HTML');
  root.dataset = {};
  root.setAttribute('data-privacy-shield', '');
  const app = new Element('DIV', 'root');
  const entry = new Element('DIV', 'privacy-entry');
  const bootstrap = new Element('DIV', 'privacy-bootstrap');
  const script = new Element('SCRIPT');
  const video = new Media();
  const audio = new Media('AUDIO');
  const themeMeta = { content: '' };
  const document = {
    body: { children: [app, entry, bootstrap, script] }, documentElement: root,
    activeElement: null, title: '', visibilityState: 'visible',
    querySelector: selector => selector === 'meta[name="theme-color"]' ? themeMeta : null,
    querySelectorAll: selector => { assert.equal(selector, 'video,audio'); return [video, audio]; },
    addEventListener: (type, fn) => add(documentListeners, type, fn),
  };
  const window = {
    __lwPrivacy: { epoch, active: true, locked: true },
    addEventListener: (type, fn) => add(windowListeners, type, fn),
  };
  const location = { pathname };
  const current = { generation, space, token: 'token-a' };
  const tokenStore = {
    generation: () => current.generation,
    isCurrent: value => value === current.generation,
    isSessionKey: key => key === 'session',
  };
  const spaceStore = { get: () => current.space, isSpaceKey: key => key === 'space' };
  const modalPauses = [];
  const globals = { window, document, location, HTMLElement: Element, HTMLMediaElement: Media, MutationObserver: Observer };
  const mask = load('mask.ts', { '../../hooks/useModal': { setModalPrivacyPause: value => modalPauses.push(value) } }, globals);
  const store = load('store.ts', { '../../lib/tokenStore': { tokenStore }, '../../lib/spaceStore': { spaceStore }, './mask': mask }, globals);
  return {
    store, mask, current, document, window, location, root, app, entry, bootstrap, script, video, audio, themeMeta, modalPauses, Element, Media,
    storage: key => dispatch(windowListeners, 'storage', { key }),
    lock: () => dispatch(windowListeners, 'lw:privacy-lock'),
    play: target => dispatch(documentListeners, 'play', { target }),
    append: node => { document.body.children.push(node); if (observer?.connected) observer.callback(); },
  };
}

function hidden(node) {
  assert.equal(node.style.getPropertyValue('display'), 'none');
  assert.equal(node.style.getPropertyPriority('display'), 'important');
  assert.equal(node.inert, true);
  assert.equal(node.getAttribute('aria-hidden'), 'true');
}

test('cold friends and hidden URLs lock; couple starts unlocked', () => {
  for (const options of [{ space: 'friends' }, { pathname: '/friends/post/1' }, { pathname: '/j/invite' }]) {
    const f = fixture(options);
    assert.equal(f.store.isPrivacyLocked(), true);
    assert.equal(f.store.canEnterHidden(), false);
    assert.equal(f.window.__lwPrivacy.active, true);
    assert.equal(f.window.__lwPrivacy.locked, true);
    hidden(f.app);
    assert.equal(f.entry.style.getPropertyValue('display'), '');
    assert.equal(f.bootstrap.style.getPropertyValue('display'), '');
    assert.equal(f.script.style.getPropertyValue('display'), '');
  }
  const f = fixture();
  assert.equal(f.store.isPrivacyLocked(), false);
  assert.equal(f.window.__lwPrivacy.active, false);
  assert.equal(f.mask.isMasked(), false);
  assert.equal(f.store.isHiddenPath('/friendship'), false);
  assert.equal(f.store.isHiddenPath('/join'), false);
  f.store.guardHiddenPath('/friends');
  assert.equal(f.store.isPrivacyLocked(), true);
  assert.equal(f.window.__lwPrivacy.active, true);
});

test('enterHidden requires visibility and publishes presentation and surface readiness', () => {
  const f = fixture({ space: 'friends' });
  f.store.setPrivacyTitle('Private title');
  f.store.setPrivacyTheme(true);
  assert.equal(f.document.title, 'Love Within');
  assert.equal(f.themeMeta.content, '#faf7f8');
  f.document.visibilityState = 'hidden';
  assert.equal(f.store.enterHidden(), false);
  assert.equal(f.store.isPrivacyLocked(), true);
  f.document.visibilityState = 'visible';
  assert.equal(f.store.enterHidden(), true);
  assert.equal(f.store.canEnterHidden(), true);
  assert.equal(f.document.title, 'Private title');
  assert.equal(f.root.dataset.theme, 'friends');
  assert.equal(f.themeMeta.content, '#f3f6fb');
  f.store.privacySurfaceReady();
  assert.equal(f.root.getAttribute('data-privacy-shield'), null);
});

test('lock invalidates epoch and stale login gesture, but current login can bind', () => {
  const f = fixture({ space: 'friends', epoch: 4 });
  f.store.enterHidden();
  const stale = f.store.privacyEpoch();
  f.window.__lwPrivacy.epoch = 9; // bootstrap increments before dispatching the lock event
  f.lock();
  assert.equal(f.store.privacyEpoch(), 9);
  assert.equal(f.store.isPrivacyCurrent(stale), false);
  assert.equal(f.store.isPrivacyLocked(), true);
  assert.equal(f.store.canEnterHidden(), false);
  f.current.generation = 'session-b';
  f.store.bindPrivacySession(stale, 'friends');
  assert.equal(f.store.isPrivacyLocked(), true);
  assert.equal(f.store.canEnterHidden(), false);
  f.store.enterHidden();
  const fresh = f.store.privacyEpoch();
  f.current.generation = 'session-c';
  f.store.bindPrivacySession(fresh, 'friends');
  assert.equal(f.store.isPrivacyLocked(), false);
  assert.equal(f.store.canEnterHidden(), true);
  f.store.bindPrivacySession(fresh, 'couple');
  assert.equal(f.store.isPrivacyLocked(), false);
  assert.equal(f.store.canEnterHidden(), false);
});

test('login bind does not retain a gesture while the document is hidden', () => {
  const f = fixture({ space: 'friends' });
  f.store.enterHidden();
  const epoch = f.store.privacyEpoch();
  f.current.generation = 'new-session';
  f.document.visibilityState = 'hidden';
  f.store.bindPrivacySession(epoch, 'friends');
  assert.equal(f.store.isPrivacyLocked(), true);
  f.document.visibilityState = 'visible';
  assert.equal(f.store.canEnterHidden(), false);
});

test('session replacement and relevant storage events invalidate access and pending navigation', () => {
  for (const key of ['session', null]) {
    const f = fixture({ space: 'friends' });
    f.store.enterHidden();
    f.store.deferPrivateNavigation('/friends/notifications/old');
    const epoch = f.store.privacyEpoch();
    f.current.generation = 'session-b';
    assert.equal(f.store.canEnterHidden(), false);
    f.storage(key);
    assert.equal(f.store.privacyEpoch(), epoch + 1);
    assert.equal(f.store.isPrivacyLocked(), true);
    f.store.enterHidden();
    assert.equal(f.store.takePrivateNavigation(), undefined);
  }
  const f = fixture();
  const version = f.store.privacyVersion();
  f.current.space = 'friends';
  f.storage('irrelevant');
  assert.equal(f.store.privacyVersion(), version);
  f.storage('space');
  assert.equal(f.store.isPrivacyLocked(), true);
});

test('token rotation within a generation does not lock a granted friends session', () => {
  const f = fixture({ space: 'friends' });
  f.store.enterHidden();
  const epoch = f.store.privacyEpoch();
  f.current.token = 'rotated-token';
  f.storage('session');
  assert.equal(f.store.privacyEpoch(), epoch);
  assert.equal(f.store.isPrivacyLocked(), false);
  assert.equal(f.store.canEnterHidden(), true);
});

test('only the latest pending notification is consumed, and never across generations', () => {
  const f = fixture({ space: 'friends' });
  f.store.deferPrivateNavigation('/friends/notifications/first');
  f.store.deferPrivateNavigation('/friends/notifications/latest');
  f.store.enterHidden();
  assert.equal(f.store.takePrivateNavigation(), '/friends/notifications/latest');
  assert.equal(f.store.takePrivateNavigation(), undefined);
  f.store.deferPrivateNavigation('/friends/notifications/stale');
  f.current.generation = 'session-b';
  f.store.enterHidden();
  assert.equal(f.store.takePrivateNavigation(), undefined);
  f.store.deferPrivateNavigation('/friends/notifications/locked');
  f.lock();
  assert.equal(f.store.takePrivateNavigation(), undefined);
  f.store.enterHidden();
  assert.equal(f.store.takePrivateNavigation(), undefined);
});

test('privacy and mask subscribers observe synchronous changes and can unsubscribe', () => {
  const f = fixture();
  const events = [];
  const stopPrivacy = f.store.subscribePrivacy(() => events.push(['privacy', f.store.privacyVersion(), f.store.isPrivacyLocked()]));
  const stopMask = f.mask.subscribeMask(() => events.push(['mask', f.mask.isMasked()]));
  const version = f.store.privacyVersion();
  f.store.guardHiddenPath('/friends');
  assert.deepEqual(events, [['mask', true], ['privacy', version + 1, true]]);
  stopPrivacy(); stopMask();
  f.store.enterHidden();
  assert.equal(events.length, 2);
});

for (const firstClear of ['hidden', 'verification']) {
  test(`mask reasons remain independent when ${firstClear} clears first; restore original state`, () => {
    const f = fixture();
    const host = new f.Element('DIV', 'verification');
    const portal = new f.Element('DIV', 'portal');
    portal.style.setProperty('display', 'grid', 'important');
    portal.inert = true;
    portal.setAttribute('aria-hidden', 'false');
    f.append(host); f.append(portal);
    f.mask.setVerificationHost(host);
    f.document.activeElement = portal;
    f.mask.setMask('verification', true);
    assert.equal(f.root.getAttribute('data-privacy-mask'), 'verification');
    hidden(f.app); hidden(portal);
    assert.equal(host.style.getPropertyValue('display'), '');
    assert.equal(portal.blurCount, 1);
    f.mask.setMask('hidden', true);
    assert.equal(f.root.getAttribute('data-privacy-mask'), 'hidden');
    hidden(host);
    assert.equal(f.entry.style.getPropertyValue('display'), '');
    const late = new f.Element('DIV', 'late-portal');
    f.append(late);
    hidden(late);
    f.mask.setMask(firstClear, false);
    assert.equal(f.mask.isMasked(), true);
    assert.equal(f.root.getAttribute('data-privacy-mask'), firstClear === 'hidden' ? 'verification' : 'hidden');
    hidden(f.app); hidden(portal); hidden(late);
    if (firstClear === 'hidden') {
      assert.equal(host.style.getPropertyValue('display'), '');
      hidden(f.entry);
    } else {
      hidden(host);
      assert.equal(f.entry.style.getPropertyValue('display'), '');
    }
    const later = new f.Element('DIV', 'later-portal');
    f.append(later);
    hidden(later);
    assert.equal(f.modalPauses.at(-1), true);
    f.mask.setMask(firstClear === 'hidden' ? 'verification' : 'hidden', false);
    assert.equal(f.mask.isMasked(), false);
    assert.equal(f.root.getAttribute('data-privacy-mask'), null);
    assert.equal(f.modalPauses.at(-1), false);
    assert.equal(portal.style.getPropertyValue('display'), 'grid');
    assert.equal(portal.style.getPropertyPriority('display'), 'important');
    assert.equal(portal.inert, true);
    assert.equal(portal.getAttribute('aria-hidden'), 'false');
    for (const node of [f.app, host, late, later]) {
      assert.equal(node.style.getPropertyValue('display'), '');
      assert.equal(node.inert, false);
      assert.equal(node.getAttribute('aria-hidden'), null);
    }
    const after = new f.Element('DIV', 'after');
    f.append(after);
    assert.equal(after.style.getPropertyValue('display'), '');
  });
}

test('media pauses on mask and on play while either reason is active', () => {
  const f = fixture();
  assert.equal(f.video.pauseCount, 0);
  f.play(f.video);
  assert.equal(f.video.pauseCount, 0);
  f.mask.setMask('hidden', true);
  assert.equal(f.video.pauseCount, 1);
  assert.equal(f.audio.pauseCount, 1);
  f.play(f.video);
  assert.equal(f.video.pauseCount, 2);
  f.mask.setMask('verification', true);
  f.mask.setMask('hidden', false);
  const previous = f.audio.pauseCount;
  f.play(f.audio);
  assert.equal(f.audio.pauseCount, previous + 1);
  f.mask.setMask('verification', false);
  f.play(f.audio);
  assert.equal(f.audio.pauseCount, previous + 1);
});
