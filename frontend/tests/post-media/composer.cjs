'use strict';
// Actual composer callbacks + actual session assertion; mocked hooks/upload/API only.
// No browser, server, database, timers, or provider calls. Worktrees can point at
// existing frontend dependencies/sources with POST_MEDIA_DEPENDENCY_ROOT / POST_MEDIA_SOURCE_ROOT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const dependencyRoot = process.env.POST_MEDIA_DEPENDENCY_ROOT || path.resolve(__dirname, '../..');
const sourceRoot = process.env.POST_MEDIA_SOURCE_ROOT || path.resolve(__dirname, '../../src');
const ts = require(require.resolve('typescript', { paths: [dependencyRoot] }));
function load(relative, mocks, globals = {}) {
  const filename = path.join(sourceRoot, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, Error, DOMException, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked ${name} in ${relative}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}
function harness(kind, edit) {
  let generation = 'session-A', cursor = 0, mounted = true;
  const cells = [], effects = [], cleanups = [];
  const calls = { upload: [], api: [], cache: [], toast: [], close: [], draft: [], state: [], error: [] };
  const record = name => (...args) => calls[name].push(args);
  const upload = deferred(), save = deferred();
  const tokenStore = { generation: () => generation, isCurrent: expected => expected === generation };
  const apiClient = load('lib/apiClient.ts', { './tokenStore': { tokenStore } });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [cells[i], value => {
        cells[i] = typeof value === 'function' ? value(cells[i]) : value;
        calls.state.push(i);
      }];
    },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn); } },
  };
  const element = (type, props) => ({ type, props: props || {} });
  const qc = {};
  const api = {
    create: input => { calls.api.push(['create', input]); return save.promise; },
    update: (id, input) => { calls.api.push(['update', id, input]); return save.promise; },
    draftMentionable() { assert.fail('mention lookup must not run'); },
  };
  const media = [{ id: 'new-video', kind: 'new', mediaType: 'video', status: 'ready', width: 16, height: 9, mimeType: 'video/mp4', blob: {} }];
  const attachments = { photos: [], videos: [{ key: 'video-key', width: 16, height: 9, mimeType: 'video/mp4' }] };
  const story = { id: 'story-1', body: 'draft text', photos: [], videos: [], mentions: [], poll: null, mood: null,
    happenedOn: '2026-11-15', createdAt: '2026-11-15T00:00:00.000Z' };
  const feedback = { error: null, setError: record('error'), errorRef: { current: null }, submitting: { current: false }, errorId: 'error', hintId: 'hint' };
  const mocks = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-dom': { createPortal: child => child },
    '@tanstack/react-query': { useQueryClient: () => qc },
    '../../hooks/useModal': { useModal: () => ({ dialogRef: { current: null }, requestClose() {} }) },
    '../../hooks/useComposerFeedback': { useComposerFeedback: () => feedback },
    '../stories/form-interactions.css': {},
    '../../components/Avatar': { Avatar: 'Avatar' },
    '../../components/Icon': { Icon: 'Icon' },
    '../../components/BottomSheet': { BottomSheet: 'BottomSheet' },
    '../../components/Switch': { Switch: 'Switch' },
    '../../components/Toast': { useToast: () => ({ success: record('toast'), info: record('toast') }) },
    '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'user-A', displayName: 'Author' }, couple: { timezone: 'UTC' } } }) },
    '../../lib/apiClient': apiClient, '../../lib/tokenStore': { tokenStore },
    '../../lib/format': { localDateOf: () => '2026-11-15', shortName: value => value, formatDay: value => value, formatDateTime: value => value },
    './api': kind === 'friends' ? { friendStoriesApi: api } : { storiesApi: api },
    './cache': Object.fromEntries((kind === 'friends'
      ? ['prependFriendStoryToFeed', 'replaceFriendStoryInCache']
      : ['prependStoryToFeed', 'replaceStoryInCache']).map(name => [name, (...args) => calls.cache.push([name, ...args])])),
  };
  const mediaPrefix = kind === 'friends' ? '../stories/' : './';
  mocks[mediaPrefix + 'PostMediaEditor'] = { PostMediaEditor: 'PostMediaEditor' };
  mocks[mediaPrefix + 'postMedia'] = { POST_MEDIA_ACCEPT: 'image/*,video/mp4,video/webm' };
  mocks[mediaPrefix + 'usePostMedia'] = { usePostMedia: () => ({ media, addFiles() {}, remove() {}, pending: false, errors: false }) };
  mocks[mediaPrefix + 'uploadPostMedia'] = { uploadPostMedia: (...args) => { calls.upload.push(args); return upload.promise; } };
  if (kind === 'friends') {
    mocks['./MentionField'] = { MentionField: 'MentionField' };
    mocks['./mentions'] = { fromPayload: () => [], toPayload: (body, mentions) => ({ body: body.trim(), mentions }) };
  } else {
    mocks['./ComposerPickers'] = { DateSheet: 'DateSheet', LeaveSheet: 'LeaveSheet', MoodSheet: 'MoodSheet' };
    mocks['./constants'] = { moodOf: () => null };
    mocks['./draft'] = { loadDraft: () => ({ body: 'draft text', mood: null, happenedOn: null }), saveDraft: record('draft'), clearDraft: record('draft') };
  }
  const file = kind === 'friends' ? 'features/friends/FriendComposer.tsx' : 'features/stories/StoryComposer.tsx';
  const exported = load(file, mocks, {
    document: { body: {} },
    window: { setTimeout: () => 1, clearTimeout() {} },
  });
  const Component = kind === 'friends' ? exported.FriendComposer : exported.StoryComposer;
  function render() {
    cursor = 0;
    const dialog = Component({ open: true, editing: edit ? story : null, initialFiles: [], initialBody: 'draft text', onClose: record('close') });
    return dialog.type(dialog.props);
  }
  let tree = render();
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  tree = render();
  const button = find(tree, node => node.type === 'button' && node.props.className?.includes('composer__submit'));
  assert.ok(button, 'actual composer submit button found');
  assert.equal(button.props.disabled, false, 'ready media makes create/edit submittable');
  function clear() { for (const list of Object.values(calls)) list.length = 0; }
  clear();
  return {
    calls, upload, save, attachments, story, clear,
    start() { button.props.onClick(); assert.equal(calls.upload.length, 1); assert.equal(typeof calls.upload[0][4], 'function', 'sequence guard passed to uploader'); },
    changeSession() { generation = 'session-B'; render(); },
    unmount() { if (mounted) { mounted = false; for (const cleanup of cleanups) cleanup(); } },
    assertGuardStale() { assert.throws(() => calls.upload[0][4](), error => error.code === 'SESSION_CHANGED' || error.name === 'AbortError'); },
  };
}
function noContinuation(h, label) {
  for (const [name, calls] of Object.entries(h.calls)) assert.equal(calls.length, 0, `${label}: unexpected ${name}`);
}

for (const kind of ['friends', 'couple']) for (const edit of [false, true]) {
  const label = `${kind}/${edit ? 'edit' : 'create'}`;
  for (const stage of ['upload', 'save']) for (const invalidation of ['session', 'unmount']) for (const outcome of ['resolve', 'reject']) {
    test(`${label}: ${invalidation} during ${stage} suppresses ${outcome} continuation`, async () => {
      const h = harness(kind, edit);
      h.start();
      if (stage === 'save') {
        h.upload.resolve(h.attachments); await tick();
        assert.equal(h.calls.api.length, 1);
        assert.equal(h.calls.api[0][0], edit ? 'update' : 'create');
      }
      if (invalidation === 'session') h.changeSession(); else h.unmount();
      h.assertGuardStale();
      h.clear();
      if (outcome === 'resolve') h[stage].resolve(stage === 'upload' ? h.attachments : h.story);
      else h[stage].reject(new Error('late failure'));
      await tick();
      noContinuation(h, label);
      h.unmount();
    });
  }
  test(`${label}: active sequence saves once, caches result, toasts and closes`, async () => {
    const h = harness(kind, edit);
    h.start();
    assert.doesNotThrow(() => h.calls.upload[0][4]());
    assert.equal(h.calls.api.length, 0, 'save waits for upload');
    h.upload.resolve(h.attachments); await tick();
    assert.equal(h.calls.api.length, 1);
    const [operation, ...args] = h.calls.api[0];
    assert.equal(operation, edit ? 'update' : 'create');
    if (edit) assert.equal(args[0], h.story.id);
    assert.equal(args.at(-1).videos, h.attachments.videos, 'prepared media reaches actual save callback');
    assert.equal(args.at(-1).body, 'draft text');
    assert.equal(h.calls.cache.length, 0, 'cache waits for successful save');
    h.save.resolve(h.story); await tick();
    assert.equal(h.calls.cache.length, 1);
    assert.match(h.calls.cache[0][0], edit ? /^replace/ : /^prepend/);
    assert.equal(h.calls.cache[0][2], h.story);
    assert.equal(h.calls.toast.length, 1);
    assert.equal(h.calls.close.length, 1);
    assert.equal(h.calls.draft.length, kind === 'couple' && !edit ? 1 : 0);
    h.unmount();
  });
}
