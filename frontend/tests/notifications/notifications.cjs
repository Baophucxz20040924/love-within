'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, mocks = {}, exports = []) {
  const filename = path.resolve(__dirname, '../../src', file);
  const source = fs.readFileSync(filename, 'utf8') + (exports.length ? `\nexport { ${exports.join(', ')} };` : '');
  const code = ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, URLSearchParams, Set, Map, Promise, console, require(name) { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; } }, { filename });
  return mod.exports;
}
function find(node, pred) {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, pred); if (result) return result; } }
  else if (node?.props) { if (pred(node)) return node; return find(node.props.children, pred); }
}
function text(node) { return Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : node == null ? '' : String(node); }

test('API uses encoded cursors and bounded page snapshot payloads', async () => {
  const calls = [];
  const { coupleNotificationsApi: api, COUPLE_NOTIFICATIONS_KEY, COUPLE_NOTIFICATION_UNREAD_KEY } = load('features/notifications/api.ts', { '../../lib/apiClient': { apiRequest: (...args) => { calls.push(args); return Promise.resolve({}); } } });
  await api.list('a/b?'); await api.seen('snapshot'); await api.read('id/1'); await api.readAll(['a', 'b']);
  assert.equal(calls[0][0], '/notifications?cursor=a%2Fb%3F');
  assert.equal(calls[1][0], '/notifications/seen'); assert.equal(calls[1][1].body.watermark, 'snapshot');
  assert.equal(calls[2][0], '/notifications/id%2F1/read');
  assert.deepEqual(calls[3][1].body.watermarks, ['a', 'b']);
  assert.equal(COUPLE_NOTIFICATIONS_KEY[0], 'couple-notifications'); assert.equal(COUPLE_NOTIFICATION_UNREAD_KEY[0], 'couple-notification-unread');
});

test('targets are local routes and moment labels and references are supported', () => {
  const p = load('features/notifications/presentation.ts');
  const row = target => ({ target });
  assert.equal(p.notificationTarget(row({ kind: 'story', id: '../../x?redirect=https://evil.test' })), '/stories/..%2F..%2Fx%3Fredirect%3Dhttps%3A%2F%2Fevil.test');
  assert.equal(p.notificationTarget(row({ kind: 'story', id: '..' })), '/stories');
  assert.equal(p.notificationTarget(row({ kind: 'approval', category: 'proposal', id: 'x' })), '/notifications?filter=approvals');
  assert.equal(p.notificationTarget(row({ kind: 'moment', dayId: 'x', localDate: '2026-11-16', sessionId: 'a/b' })), '/moments?date=2026-11-16&session=a%2Fb');
  assert.equal(p.notificationTarget(row({ kind: 'moment', localDate: '//evil.test' })), '/moments');
  assert.equal(p.notificationTarget(row({ kind: 'https://evil.test', id: 'a' })), '/');
  for (const type of ['moment_prompt', 'moment_posted', 'moment_both']) assert.notEqual(p.notificationLabel(type), p.notificationLabel('unknown'));
  assert.equal(p.notificationTarget(row(null)), '/');
});

test('activity acknowledges loaded snapshots separately from read; read errors do not navigate', async () => {
  const events = [], effects = [], mutations = [];
  let generation = 'A';
  const jsx = (type, props) => ({ type, props: props || {} });
  const api = { list() {}, seen() {}, read() {}, readAll() {} };
  const pages = [{ watermark: 'page-one', nextCursor: 'cursor', items: [{ id: 'n1', type: 'moment_prompt', actorId: null, target: { kind: 'moment', dayId: 'd' }, read: false, createdAt: '2026-01-01' }] }, { watermark: 'page-two', nextCursor: null, items: [] }];
  const qc = { invalidateQueries: x => { events.push(['invalidate', x.queryKey[0]]); return Promise.resolve(); } };
  const mocks = {
    react: { useRef: value => ({ current: value }), useEffect: fn => effects.push(fn) },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-router-dom': { useNavigate: () => target => events.push(['navigate', target]), useSearchParams: () => [new URLSearchParams(), () => {}] },
    '@tanstack/react-query': {
      useQueryClient: () => qc,
      useInfiniteQuery: () => ({ data: { pages }, isSuccess: true, hasNextPage: false }),
      useMutation: config => { const kind = ['seen', 'read', 'readAll'][mutations.length]; const m = { config, isPending: false, isError: false, reset() {}, mutate(value, options) { events.push(['mutate', kind, value]); if (options) m.options = options; } }; mutations.push(m); return m; },
    },
    '../components/Avatar': { Avatar: 'Avatar' }, '../components/Icon': { Icon: 'Icon' }, '../components/SegmentedControl': { SegmentedControl: 'SegmentedControl' },
    '../components/StatusViews': { EmptyState: 'EmptyState', ErrorState: 'ErrorState', Page: 'Page', Skeleton: 'Skeleton' },
    '../features/auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'me' }, couple: { members: [] } } }) },
    '../features/approvals/useApprovals': { useApprovals: () => ({ count: 2 }) },
    '../features/notifications/api': { COUPLE_NOTIFICATIONS_KEY: ['couple-notifications'], COUPLE_NOTIFICATION_UNREAD_KEY: ['couple-notification-unread'], coupleNotificationsApi: api },
    '../features/notifications/presentation': { notificationTarget: () => '/moments', notificationLabel: () => 'moment', notificationIcon: () => 'camera' },
    '../lib/format': { timeAgo: () => 'now' }, '../lib/apiClient': { currentAccessEpoch: () => 1 }, '../lib/tokenStore': { tokenStore: { generation: () => generation, isCurrent: value => value === generation } }, '../features/appLock/store': { appLockEpoch: () => 1, isAppLockCurrent: () => true }, './ApprovalsPage': { ApprovalsPage: 'ApprovalsPage' },
  };
  const { ActivityFeed } = load('pages/CoupleNotificationsPage.tsx', mocks, ['ActivityFeed']);
  const tree = ActivityFeed(); effects.forEach(fn => fn());
  assert.deepEqual(Array.from(events[0][2].tokens), ['page-one', 'page-two']);
  assert.equal(events.some(x => x[1] === 'readAll'), false);
  find(tree, x => x.type === 'button' && x.props.className?.includes('notif')).props.onClick();
  assert.equal(events.some(x => x[0] === 'navigate'), false);
  assert.equal(events.at(-1)[1], 'read');
  generation = 'B'; mutations[1].options.onSuccess(); assert.equal(events.some(x => x[0] === 'navigate'), false, 'stale read must not navigate');
  generation = 'A'; mutations[1].options.onSuccess(); assert.equal(events.at(-1)[1], '/moments');
  const readAllButton = find(tree, x => x.type === 'button' && text(x).includes('Đọc các thông báo đã tải'));
  readAllButton.props.onClick(); assert.deepEqual(Array.from(events.at(-1)[2].tokens), ['page-one', 'page-two']);
});
