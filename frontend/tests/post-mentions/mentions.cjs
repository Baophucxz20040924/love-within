'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const root = path.resolve(__dirname, '../../src');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, ...globals, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name];
  } }, { filename });
  return module.exports;
}
const plain = x => JSON.parse(JSON.stringify(x));
const mentions = load('features/friends/mentions.ts');
const user = { id: 'b', displayName: 'Bảo Nguyễn', avatarUrl: null };
const inserted = mentions.insertMention('  🌻 Xin @bao', [], { start: 9, query: 'bao' }, 13, user);
assert.equal(inserted.text, '  🌻 Xin @Bảo Nguyễn ');
const payload = mentions.toPayload(inserted.text, inserted.mentions);
assert.deepEqual(plain(payload), { body: '🌻 Xin @Bảo Nguyễn', mentions: [{ userId: 'b', offset: 7, length: 11 }] });
const hydrated = mentions.fromPayload(payload.body, payload.mentions);
assert.deepEqual(plain(mentions.toPayload(payload.body, hydrated)), plain(payload));
const movedText = 'Chào ' + payload.body;
assert.equal(mentions.reconcile(payload.body, movedText, hydrated)[0].start, 12);
assert.equal(mentions.reconcile(payload.body, payload.body.replace('Bảo', 'Bao'), hydrated).length, 0);
assert.equal(mentions.activeQuery('a@b', 3, []), null);
assert.equal(mentions.activeQuery('Xin @bao\n', 9, []), null);
assert.equal(mentions.activeQuery(payload.body, payload.body.length, hydrated), null);
assert.deepEqual(plain(mentions.segments(payload.body, payload.mentions)), [{ text: '🌻 Xin ' }, { text: '@Bảo Nguyễn', userId: 'b' }]);
assert.deepEqual(plain(mentions.segments('hello', [{ userId: 'x', offset: 0, length: 3 }])), [{ text: 'hello' }]);
assert.equal(mentions.fromPayload('hello', [{ userId: 'x', offset: -1, length: 3 }]).length, 0);
assert.equal(mentions.toPayload(' @A '.repeat(11), Array.from({ length: 11 }, (_, i) => ({ userId: 'b', name: 'A', start: i * 4 + 1, length: 2 }))).mentions.length, 10);

// Exercise real picker handlers with a tiny hook harness; no renderer or browser dependency.
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
let states; let cursor; let refs; let refCursor; let queried; let queryResult;
const react = {
  useState(init) { const i = cursor++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], x => { states[i] = typeof x === 'function' ? x(states[i]) : x; }]; },
  useRef(init) { const i = refCursor++; return refs[i] ??= { current: init }; },
  useId: () => 'test-picker', useEffect() {},
};
const { MentionField } = load('features/friends/MentionField.tsx', {
  react, 'react/jsx-runtime': jsx, '@tanstack/react-query': { useQuery: input => { queried = input; return queryResult; } },
  '../../components/Avatar': { Avatar() {} }, './api': { friendMentionableKey: (id, q) => ['friends', 'mentionable', id, q] }, './mentions': mentions,
}, { requestAnimationFrame: fn => fn() });
function nodes(node, type, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) nodes(child, type, out);
  return out;
}
function fixture(overrides = {}) {
  states = []; refs = []; queryResult = { data: [user], isPlaceholderData: false, isFetching: false, isError: false };
  const calls = []; const input = { focus() {}, setSelectionRange(start) { this.selectionStart = start; } };
  const props = { search: { id: 'draft-post', fn: async () => [user] }, text: '@', mentions: [], inputRef: { current: input },
    placeholder: 'Viết', variant: 'composer', maxLength: 20000, rows: 3, label: 'Nội dung bài viết',
    onChange: (...x) => calls.push(x), onKeyDown: () => calls.push('fallback'), ...overrides };
  function render() { cursor = 0; refCursor = 0; return MentionField(props); }
  render(); states[0] = props.text.length; // caret
  return { props, calls, render, input };
}
const key = (name, extra = {}) => ({ key: name, nativeEvent: {}, keyCode: 0, preventDefault() { this.prevented = true; }, ...extra });
let f = fixture(); let tree = f.render(); let box = nodes(tree, 'textarea')[0];
assert.equal(box.props.maxLength, 20000); assert.equal(box.props.rows, 3); assert.equal(box.props['aria-label'], 'Nội dung bài viết');
assert.equal(queried.queryKey[2], 'draft-post');
let enter = key('Enter'); box.props.onKeyDown(enter); assert.equal(enter.prevented, true); assert.equal(f.calls[0][0], '@Bảo Nguyễn ');
f = fixture(); tree = f.render(); box = nodes(tree, 'textarea')[0];
box.props.onKeyDown(key('Enter', { nativeEvent: { isComposing: true } })); assert.equal(f.calls.length, 0);
box.props.onCompositionStart(); box.props.onKeyDown(key('Enter')); assert.equal(f.calls.length, 0);
box.props.onCompositionEnd({ currentTarget: { selectionStart: 1 } });
box.props.onKeyDown(key('Escape')); tree = f.render(); box = nodes(tree, 'textarea')[0];
box.props.onKeyDown(key('Enter')); assert.equal(f.calls.at(-1), 'fallback', 'Enter without suggestions remains multiline in a post');
f = fixture({ maxLength: 3 }); tree = f.render(); nodes(tree, 'textarea')[0].props.onKeyDown(key('Enter')); assert.equal(f.calls.length, 0); assert.ok(nodes(f.render(), 'p').length);
f = fixture({ readOnly: true }); tree = f.render(); assert.equal(nodes(tree, 'li').length, 0); nodes(tree, 'textarea')[0].props.onKeyDown(key('Enter')); assert.equal(f.calls.length, 0);
f = fixture({ mentions: Array.from({ length: 10 }, (_, i) => ({ userId: `${i}`, name: 'A', start: 5 + i * 3, length: 2 })) });
assert.equal(nodes(f.render(), 'li').length, 0);
f = fixture({ variant: undefined, maxLength: undefined, rows: undefined, label: undefined }); box = nodes(f.render(), 'textarea')[0];
assert.equal(box.props.maxLength, 2000); assert.equal(box.props.rows, 1); assert.equal(box.props['aria-label'], 'Viết bình luận');
queryResult.isPlaceholderData = true; assert.equal(nodes(f.render(), 'li').length, 0, 'stale results cannot be selected');
console.log('PASS post mentions: UTF-16 payload/hydration/reconciliation/rendering, picker scope, keyboard/IME, limits, readonly and comment defaults');
