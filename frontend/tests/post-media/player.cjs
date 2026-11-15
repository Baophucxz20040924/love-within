'use strict';
// Actual PostVideo component, isolated hooks/DOM/media mocks: no browser, server, or provider.
// A dependency/source-free worktree may set POST_MEDIA_DEPENDENCY_ROOT (frontend directory)
// and POST_MEDIA_SOURCE_ROOT (frontend/src directory) to existing absolute paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const dependencyRoot = process.env.POST_MEDIA_DEPENDENCY_ROOT || path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [dependencyRoot] }));
const sourceRoot = process.env.POST_MEDIA_SOURCE_ROOT || path.resolve(__dirname, '../../src');
const filename = path.join(sourceRoot, 'features/stories/PostVideo.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness({ verification = 'clear', observer = true } = {}) {
  const states = [], refs = [], effects = [], stores = [], observers = [];
  const documentListeners = new Set(), verificationListeners = new Set();
  let stateCursor, refCursor, effectCursor, storeCursor, mounted = true, dirty = false, tree;
  let props = { src: 'https://storage.invalid/private-video.mp4' };
  const video = {
    paused: true, pauseCalls: 0, playCalls: 0, props: {},
    pause() { this.paused = true; this.pauseCalls++; },
    play() { this.paused = false; this.playCalls++; return Promise.resolve(); },
  };
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); documentListeners.add(callback); },
    removeEventListener(name, callback) { assert.equal(name, 'visibilitychange'); documentListeners.delete(callback); },
  };
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { assert.equal(target, video); this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useRef(initial) { const i = refCursor++; return refs[i] ??= { current: initial }; },
    useState(initial) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (update) => {
        const next = typeof update === 'function' ? update(states[i]) : update;
        if (!Object.is(next, states[i])) { states[i] = next; dirty = true; }
      }];
    },
    useEffect(fn, deps) {
      const i = effectCursor++, old = effects[i];
      if (!old || !sameDeps(old.deps, deps)) effects[i] = { fn, deps, cleanup: old?.cleanup, pending: true };
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const i = storeCursor++;
      if (!stores[i]) stores[i] = { cleanup: subscribe(() => { dirty = true; }) };
      return getSnapshot();
    },
  };
  const jsx = (type, elementProps) => {
    if (type === 'video') { elementProps.ref.current = video; video.props = elementProps; }
    return { type, props: elementProps };
  };
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './PostVideo.css': {},
    '../realtime/verification': {
      getVerificationStatus: () => verification,
      subscribeVerification(callback) { verificationListeners.add(callback); return () => verificationListeners.delete(callback); },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, document,
    ...(observer ? { IntersectionObserver } : {}),
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name]; },
  }, { filename });
  function flush() {
    assert.ok(mounted, 'cannot render unmounted component');
    let count = 0;
    do {
      assert.ok(++count < 20, 'render must settle');
      dirty = false;
      stateCursor = refCursor = effectCursor = storeCursor = 0;
      tree = module.exports.PostVideo(props);
      // JSX has attached refs before passive effect setup, as in a mounted React tree.
      for (const effect of effects) if (effect.pending) {
        effect.cleanup?.(); effect.pending = false; effect.cleanup = effect.fn();
      }
    } while (dirty);
  }
  flush();
  return {
    video, documentListeners, verificationListeners, observers,
    get tree() { return tree; },
    userPlay() { video.paused = false; video.props.onPlay(); },
    verify(next) { verification = next; for (const callback of verificationListeners) callback(); if (dirty) flush(); },
    visibility(next) { document.visibilityState = next; for (const callback of documentListeners) callback(); },
    intersect(visible) { const current = observers.at(-1); assert.ok(current && !current.disconnected); current.callback([{ target: video, isIntersecting: visible }]); },
    changeSource(src) { props = { ...props, src }; flush(); },
    fail() { video.props.onError(); flush(); },
    replayEffects() { for (const effect of effects) { effect.cleanup?.(); effect.cleanup = effect.fn(); } },
    unmount() {
      assert.ok(mounted); mounted = false;
      for (const effect of effects) effect.cleanup?.();
      for (const store of stores) store.cleanup?.();
      for (const ref of refs) ref.current = null;
    },
  };
}

test('player is native-controls, inline, metadata-only and never autoplays', () => {
  const h = harness();
  assert.equal(h.video.props.controls, true);
  assert.equal(h.video.props.playsInline, true);
  assert.equal(h.video.props.preload, 'metadata');
  assert.ok(!h.video.props.autoPlay);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.video.paused, true);
  assert.equal(h.documentListeners.size, 1);
  assert.equal(h.verificationListeners.size, 1);
  h.userPlay(); assert.equal(h.video.paused, false, 'visible verified media can be played by user');
  h.unmount();
});

test('checking/failed verification pauses retained video and rejects play until clear, without autoresume', () => {
  const h = harness();
  for (const status of ['checking', 'failed']) {
    h.verify('clear'); h.userPlay();
    const calls = h.video.pauseCalls;
    h.verify(status);
    assert.equal(h.video.paused, true, status);
    assert.ok(h.video.pauseCalls > calls, 'verification change actively pauses mounted video');
    h.userPlay(); assert.equal(h.video.paused, true, 'play blocked while privacy mask active');
    h.verify('clear');
    assert.equal(h.video.paused, true, 'removing mask does not resume private audio');
    assert.equal(h.video.playCalls, 0);
  }
  h.unmount();
  const initiallyMasked = harness({ verification: 'checking' });
  assert.ok(initiallyMasked.video.pauseCalls > 0, 'mount while masked pauses immediately');
  initiallyMasked.userPlay(); assert.equal(initiallyMasked.video.paused, true);
  initiallyMasked.unmount();
});

test('document hidden pauses and blocks play, returning visible never autoresumes', () => {
  const h = harness();
  h.userPlay();
  h.visibility('hidden');
  assert.equal(h.video.paused, true);
  h.userPlay(); assert.equal(h.video.paused, true, 'onPlay guard also handles hidden document');
  h.visibility('visible');
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 0);
  h.userPlay(); assert.equal(h.video.paused, false, 'user may explicitly resume after visibility restored');
  h.unmount();
});

test('viewport exit pauses; reentry does not autoplay or resume', () => {
  const h = harness();
  h.intersect(true); h.userPlay();
  const calls = h.video.pauseCalls;
  h.intersect(false);
  assert.equal(h.video.paused, true);
  assert.ok(h.video.pauseCalls > calls);
  h.intersect(true);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 0);
  h.unmount();
});

test('source replacement, StrictMode replay and unmount pause and clean observers/listeners', () => {
  const h = harness();
  h.userPlay();
  const firstObserver = h.observers[0];
  h.changeSource('https://storage.invalid/refreshed-private-url.mp4');
  assert.equal(firstObserver.disconnected, true);
  assert.equal(h.video.paused, true, 'old playback stopped when URL changes');
  assert.equal(h.documentListeners.size, 1, 'source change must not leak event listeners');
  h.replayEffects();
  assert.equal(h.documentListeners.size, 1, 'StrictMode cleanup/setup must not duplicate listeners');
  assert.equal(h.observers.filter(observer => !observer.disconnected).length, 1);
  h.userPlay();
  h.unmount();
  assert.equal(h.video.paused, true);
  assert.equal(h.documentListeners.size, 0);
  assert.equal(h.verificationListeners.size, 0);
  assert.ok(h.observers.every(observer => observer.disconnected));
  assert.equal(h.video.playCalls, 0);
});

test('no IntersectionObserver still enforces privacy/visibility and media errors stay local', () => {
  const h = harness({ observer: false });
  h.userPlay(); h.verify('failed'); assert.equal(h.video.paused, true);
  h.verify('clear'); h.userPlay(); h.visibility('hidden'); assert.equal(h.video.paused, true);
  h.fail();
  const children = h.tree.props.children;
  assert.ok(children.some(child => child?.type === 'video'), 'failed video does not destroy card/player');
  assert.ok(children.some(child => child?.type === 'p' && child.props.role === 'status'), 'playback error shown inline');
  h.changeSource('blob:retry');
  assert.ok(!h.tree.props.children.some(child => child?.type === 'p'), 'new source clears old playback error');
  h.unmount();
  assert.equal(h.documentListeners.size, 0);
  assert.equal(h.video.playCalls, 0);
});
