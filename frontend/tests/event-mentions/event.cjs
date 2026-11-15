'use strict';
// Real API adapter, picker, comment component and invalidation logic with isolated hooks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../src');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, ...globals, require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
const plain = x => JSON.parse(JSON.stringify(x));
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
function nodes(node, type, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) nodes(child, type, out);
  return out;
}
const requests = [];
const api = load('features/friends/api.ts', { '../../lib/apiClient': { apiRequest: (...args) => { requests.push(args); return Promise.resolve([]); } }, '../../lib/image': {} });
const payload = { body: '😀 @Việt', parentId: 'parent', mentions: [{ userId: 'user', offset: 3, length: 5 }] };
api.friendEventsApi.addComment('event/id', payload);
assert.equal(requests[0][0], '/friends/events/event%2Fid/comments');
assert.equal(requests[0][1].body, payload, 'adapter forwards spans and parent without remapping');
api.friendEventsApi.mentionable('event/id', 'Vi ệt');
assert.equal(requests[1][0], '/friends/events/event%2Fid/mentionable?q=Vi%20%E1%BB%87t');
assert.deepEqual(plain(api.friendMentionableKey('same', '', 'event')), ['friends','event-mentionable','same','']);
assert.deepEqual(plain(api.friendMentionableKey('same', '', 'story')), ['friends','mentionable','same','']);

const mentions = load('features/friends/mentions.ts');
let states, cursor, refs, refCursor, queryResult, queryOptions;
const react = {
  useState(init) { const i = cursor++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], x => { states[i] = typeof x === 'function' ? x(states[i]) : x; }]; },
  useRef(init) { const i = refCursor++; return refs[i] ??= { current: init }; }, useId: () => 'id', useEffect() {},
};
const user = { id: 'guest', displayName: 'Việt', avatarUrl: null };
const { MentionField } = load('features/friends/MentionField.tsx', { react, 'react/jsx-runtime': jsx,
  '@tanstack/react-query': { useQuery: options => { queryOptions = options; return queryResult; } },
  '../../components/Avatar': { Avatar() {} }, './api': api, './mentions': mentions,
}, { requestAnimationFrame: fn => fn() });
function picker(resource) {
  states = []; refs = []; queryResult = { data: [user], isPlaceholderData: false, isFetching: false, isError: false };
  const props = { search: { id: 'same', resource, fn: () => Promise.resolve([user]) }, text: '@', mentions: [], inputRef: { current: { focus() {}, setSelectionRange() {} } }, placeholder: '', onChange() {} };
  const render = () => { cursor = 0; refCursor = 0; return MentionField(props); };
  render(); states[0] = 1; return render;
}
let render = picker('event');
assert.equal(nodes(render(), 'li').length, 1);
assert.deepEqual(plain(queryOptions.queryKey), ['friends','event-mentionable','same','']);
assert.equal(queryOptions.staleTime, 0); assert.equal(queryOptions.refetchOnMount, 'always');
queryResult.isFetching = true; assert.equal(nodes(render(), 'li').length, 0, 'retained roster is hidden during revalidation');
queryResult.isFetching = false; queryResult.isError = true; assert.equal(nodes(render(), 'li').length, 0, 'revoked/error query cannot expose cached roster');
queryResult.isError = false; queryResult.isPlaceholderData = true; assert.equal(nodes(render(), 'li').length, 0);
render = picker('story'); render(); assert.equal(queryOptions.staleTime, 30000); assert.equal(queryOptions.queryKey[1], 'mentionable');

let thread, mutationInput;
const qc = { setQueryData() {} };
const commentMocks = {
  react, 'react/jsx-runtime': jsx, 'react-router-dom': { Link() {} },
  '@tanstack/react-query': { useQueryClient: () => qc, useQuery: () => ({ data: [thread], isSuccess: true }), useMutation: () => ({ mutate: x => { mutationInput = x; }, isPending: false }) },
  '../../components/Avatar': { Avatar() {} }, '../../components/BottomSheet': { BottomSheet() {} }, '../../components/Icon': { Icon() {} }, '../../components/StatusViews': { Skeleton() {} },
  '../../components/Toast': { useToast: () => ({}) }, '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'me' } } }) },
  '../../lib/apiClient': { ApiRequestError: class extends Error {} }, '../../lib/format': { timeAgo: () => '' }, './api': api, './cache': {},
  './MentionField': { MentionField }, './mentions': mentions, './SafetySheets': { BlockSheet() {}, ReportSheet() {} }, '../stories/form-interactions.css': {},
};
const { eventCommentApi, FriendComments } = load('features/friends/FriendComments.tsx', commentMocks, { requestAnimationFrame: () => {} });
const adapter = eventCommentApi('event/id');
assert.equal(adapter.mention.resource, 'event'); assert.equal(adapter.mention.id, 'event/id');
adapter.add(payload); assert.equal(requests.at(-1)[1].body, payload);
adapter.mention.fn('V'); assert.equal(requests.at(-1)[0], '/friends/events/event%2Fid/mentionable?q=V');
function reply(canMentionAuthor) {
  states = []; refs = []; mutationInput = undefined;
  thread = { id: 'root', author: user, parentId: null, body: 'old', mentions: [], canMentionAuthor, replies: [], isMine: false };
  const renderComments = () => { cursor = 0; refCursor = 0; return FriendComments({ api: adapter, focusKey: 0 }); };
  let tree = renderComments();
  // The generated CommentItem component receives the actual reply handler.
  const item = nodes(tree, 'div').flatMap(n => [n.props?.children].flat(Infinity)).find(n => n && typeof n.type === 'function' && n.props?.c === thread);
  assert.ok(item); item.props.onReply(thread);
  tree = renderComments();
  const field = nodes(tree, MentionField)[0]; assert.equal(field.props.text, '@Việt ');
  nodes(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
  return mutationInput;
}
assert.deepEqual(plain(reply(false)), { body: '@Việt', mentions: [], parentId: 'root' });
assert.deepEqual(plain(reply(true)), { body: '@Việt', mentions: [{ userId: 'guest', offset: 0, length: 5 }], parentId: 'root' });

let epochs = 0;
const invalidation = load('features/realtime/invalidation.ts', { '../../lib/apiClient': { advanceAccessEpoch: () => { epochs++; }, ApiRequestError: class extends Error {} }, './parser': { DOMAINS: ['friend-events', 'friend-posts', 'account'] } });
const calls = [];
const cache = { cancelQueries: x => calls.push(['cancel', plain(x.queryKey)]), resetQueries: x => calls.push(['reset', plain(x.queryKey)]) };
invalidation.revokeDomains(cache, 'friends', ['friend-events']);
assert.equal(epochs, 1);
assert.ok(calls.some(([action,key]) => action === 'cancel' && key[1] === 'event-mentionable'));
assert.ok(calls.some(([action,key]) => action === 'reset' && key[1] === 'event-mentionable'));
assert.ok(!calls.some(([,key]) => key[1] === 'mentionable'), 'event revoke does not reset story picker');
console.log('PASS event mention API, adapter, picker, plain reply and realtime revoke');
