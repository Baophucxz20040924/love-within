'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
function load(file, mocks) {
  const filename = path.join(root, file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name];
  } }, { filename });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const requested = [];
const api = load('features/friends/api.ts', {
  '../../lib/apiClient': { apiRequest: (...args) => requested.push(args) },
  '../../lib/image': {},
});
api.friendStoriesApi.reactions('post/a');
api.friendStoriesApi.reactions('post/a', 'id +/');
assert.deepEqual(plain(requested.map(x => x[0])), [
  '/friends/stories/post%2Fa/reactions?limit=50', '/friends/stories/post%2Fa/reactions?limit=50&cursor=id%20%2B%2F',
]);
assert.deepEqual(plain(api.friendReactionsKey('1')), ['friends', 'reactions', '1']);

class ApiRequestError extends Error { constructor(status) { super('error'); this.status = status; } }
const jsx = (type, props) => ({ type, props: props || {} });
let result, options, retries = 0, next = 0;
const sheet = load('features/friends/FriendReactionsSheet.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  '@tanstack/react-query': { useInfiniteQuery: o => { options = o; return result; } },
  '../../components/BottomSheet': { BottomSheet: 'sheet' },
  '../../components/StatusViews': { ErrorState: 'error', Skeleton: 'skeleton' },
  '../../lib/apiClient': { ApiRequestError },
  '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'me' } } }) },
  '../stories/ReactionPeople': { ReactionPeople: 'people' },
  './api': api,
});
const a = { id: 'me', displayName: 'My Full Name', avatarUrl: null, type: 'love' };
const b = { id: 'b', displayName: 'Other Name', avatarUrl: null, type: 'sad' };
const pages = [{ items: [a, b], nextCursor: 'b' }, { items: [b], nextCursor: null }];
assert.deepEqual(plain(sheet.uniqueReactors(pages)), [a, b]);
const base = { data: { pages }, error: null, isPending: false, isFetching: false, isFetchingNextPage: false,
  isError: false, isFetchNextPageError: false, hasNextPage: true, refetch: () => { retries++; }, fetchNextPage: () => { next++; } };
function render(overrides = {}) { result = { ...base, ...overrides }; return sheet.FriendReactionsSheet({ storyId: '1', onClose() {} }); }
function nodes(node, type) {
  if (Array.isArray(node)) return node.flatMap(item => nodes(item, type));
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
let tree = render();
assert.equal(options.refetchOnMount, 'always');
assert.equal(options.initialPageParam, null);
assert.equal(options.getNextPageParam(pages[0]), 'b');
assert.equal(options.retry(0, new ApiRequestError(403)), false);
assert.equal(options.retry(0, new Error('offline')), true);
assert.equal(nodes(tree, 'people')[0].props.myId, 'me');
assert.deepEqual(plain(nodes(tree, 'people')[0].props.people), [a, b]);
nodes(tree, 'button')[0].props.onClick(); assert.equal(next, 1);
tree = render({ isFetching: true });
assert.equal(nodes(tree, 'skeleton').length, 1); assert.equal(nodes(tree, 'people').length, 0);
tree = render({ isError: true, error: new ApiRequestError(403) });
assert.equal(nodes(tree, 'people').length, 0); assert.equal(nodes(tree, 'error').length, 1);
nodes(tree, 'error')[0].props.onRetry(); assert.equal(retries, 1);
tree = render({ isError: true, isFetchNextPageError: true, error: new ApiRequestError(404) });
assert.equal(nodes(tree, 'people').length, 0, 'denied next page hides retained earlier pages');
tree = render({ isError: true, isFetchNextPageError: true, error: new Error('offline') });
assert.equal(nodes(tree, 'people').length, 1); nodes(tree, 'error')[0].props.onRetry(); assert.equal(next, 2);
tree = render({ data: { pages: [{ items: [], nextCursor: null }] }, hasNextPage: false });
assert.equal(nodes(tree, 'people').length, 0); assert.equal(nodes(tree, 'p').length, 1);
console.log('PASS reaction API, paging, dedupe, loading, errors and ACL concealment');
