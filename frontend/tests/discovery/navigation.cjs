'use strict';
// Actual page/strip render functions with query and React boundaries mocked; no browser or API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const jsx = (type, props) => ({ type, props: props || {} });
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function load(relative, mocks) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`); return mocks[name];
  } }, { filename });
  return mod.exports;
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node?.props) return [];
  return [...(predicate(node) ? [node] : []), ...nodes(node.props.children, predicate)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  return node?.props ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
}
function home(pulse) {
  return load('pages/HomePage.tsx', {
    react: { useState: value => [value, () => {}] }, 'react/jsx-runtime': runtime,
    'react-router-dom': { Link: 'Link' },
    '@tanstack/react-query': { useQuery: ({ queryKey }) => queryKey[0] === 'pulse' ? pulse : {} },
    '../components/Avatar': { Avatar: 'Avatar' }, '../components/Icon': { Icon: 'Icon' },
    '../components/ProgressBar': { ProgressBar: 'ProgressBar' },
    '../components/StatusViews': { Page: 'Page', Skeleton: 'Skeleton', ErrorState: 'ErrorState' },
    '../components/WalletCard': { WalletCard: 'WalletCard' },
    '../features/auth/AuthContext': { useAuth: () => ({ me: null }) },
    '../features/approvals/useApprovals': { useApprovals: () => ({ incoming: [], count: 0 }) },
    '../features/couple/api': { COUPLE_KEY: ['couple'], PULSE_KEY: ['pulse'], coupleApi: {} },
    '../features/events/UpcomingCard': { UpcomingCard: 'UpcomingCard' },
    '../features/finance/api': {}, '../features/letters/LettersCard': { LettersCard: 'LettersCard' },
    '../features/moments/MomentCard': { MomentCard: 'MomentCard' },
    '../features/nudges/MoodControls': {}, '../features/nudges/NudgeControls': {},
    '../features/nudges/useNudgeSender': {}, '../features/questions/QuestionCard': { QuestionCard: 'QuestionCard' },
    '../features/savings/SavingsViews': {}, '../features/quests/api': {},
    '../lib/format': { formatToday: () => 'Hôm nay' },
  }).HomePage();
}
const scenarios = [
  ['missing', {}], ['loading', { isPending: true }], ['error', { isError: true }],
  ...['waiting', 'open', 'posted', 'both'].map(state => [state, { data: { moment: { state }, nextEvent: null } }]),
  ['expired', { data: { moment: { state: 'open', closesAt: '2000-01-01T00:00:00Z' } } }],
  ['legacy', { data: { moment: { state: 'open', scheduleVersion: 2 } } }],
  ['stale-error', { isError: true, data: { moment: { state: 'both' }, nextEvent: { id: 'event' } } }],
];
for (const [name, pulse] of scenarios) test(`Home keeps labeled navigation independent of ${name} activity`, () => {
  const tree = home(pulse);
  const nav = nodes(tree, node => node.type === 'nav' && node.props['aria-label'] === 'Khám phá cùng nhau');
  assert.equal(nav.length, 1);
  const links = nodes(nav[0], node => node.type === 'Link');
  assert.deepEqual(links.map(link => link.props.to), ['/moments', '/events']);
  assert.match(text(links[0]), /Khoảnh khắc/); assert.match(text(links[1]), /Sự kiện/);
  assert.equal(nodes(nav[0], node => node.type === 'input' || node.props.onClick).length, 0);
  assert.equal(nodes(tree, node => node.type === 'MomentCard').length, pulse.data?.moment?.state === 'open' ? 1 : 0);
  assert.equal(nodes(tree, node => node.type === 'UpcomingCard').length, pulse.data?.nextEvent ? 1 : 0);
});
for (const state of ['loading', 'empty', 'error', 'stale-error']) test(`Friends Kèo entry and creation survive ${state}`, () => {
  let creating = false, retried = 0;
  const query = { isLoading: state === 'loading', isSuccess: state === 'empty', isError: state.includes('error'),
    data: { items: state === 'stale-error' ? [{ id: 'old', status: 'active' }] : [] }, refetch: () => retried++ };
  const { FriendEventStrip } = load('features/friends/FriendEventStrip.tsx', {
    react: { useState: () => [creating, value => { creating = value; }] }, 'react/jsx-runtime': runtime,
    'react-router-dom': { Link: 'Link', useNavigate: () => () => {} },
    '@tanstack/react-query': { useQuery: () => query },
    '../../components/Avatar': {}, '../../components/Icon': { Icon: 'Icon' },
    './api': { friendEventsApi: {}, FRIEND_EVENT_STRIP_KEY: ['strip'] }, './eventFormat': {},
    './FriendEventSheet': { FriendEventSheet: 'FriendEventSheet' },
  });
  const tree = FriendEventStrip();
  assert.equal(nodes(tree, node => node.type === 'Link' && node.props.to === '/friends/events').length, 1);
  const create = nodes(tree, node => node.type === 'button' && text(node) === 'Lên kèo');
  assert.equal(create.length, 1); create[0].props.onClick();
  assert.equal(nodes(FriendEventStrip(), node => node.type === 'FriendEventSheet')[0].props.open, true);
  if (query.isError) {
    nodes(tree, node => node.type === 'button' && text(node) === 'Thử lại')[0].props.onClick();
    assert.equal(retried, 1);
    assert.equal(nodes(tree, node => typeof node.type === 'function').length, 0, 'Do not expose stale event cards on error');
  }
});
