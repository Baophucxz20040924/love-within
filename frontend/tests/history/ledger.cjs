'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
function load(file, mocks) {
  const filename = path.resolve(__dirname, '../../src', file), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name];
  } }, { filename }); return module.exports;
}
const requests = [];
const api = load('features/quests/api.ts', { '../../lib/apiClient': { apiRequest: (...args) => { requests.push(args); return Promise.resolve(); } } });
const signal = new AbortController().signal;
api.walletApi.ledgerPage('cursor+/=', 'coin', signal);
assert.equal(requests[0][0], '/ledger/page?limit=20&cursor=cursor%2B%2F%3D&type=coin');
assert.equal(requests[0][1].signal, signal);
api.walletApi.ledger(); assert.equal(requests[1][0], '/ledger');
let state = [], index, query, tree;
let result = { data: { items: Array.from({ length: 20 }, (_, n) => ({ id: String(n) })), nextCursor: 'older' } };
const jsx = (type, props) => ({ type, props });
const mocks = {
  react: { useState(init) { const i = index++; if (!(i in state)) state[i] = init; return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; }, useEffect() {} },
  'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { Link: 'Link' },
  '@tanstack/react-query': { useQuery: options => { query = options; return { isFetching: false, refetch() {}, ...result }; } },
  '../components/Avatar': {}, '../components/BottomSheet': {}, '../components/Icon': {},
  '../components/StatusViews': { EmptyState: 'EmptyState', ErrorState: 'ErrorState', Skeleton: 'Skeleton' },
  '../components/Toast': {}, '../components/WalletCard': {}, '../features/auth/AuthContext': {},
  '../features/finance/FinanceSettings': {}, '../features/profile/AvatarSheet': {}, '../features/proposals/api': {},
  '../features/quests/api': { ...api }, '../features/water/api': {}, '../lib/apiClient': {}, '../lib/format': {}, '../lib/installPrompt': {},
};
const { Ledger, LedgerRow } = load('pages/ProfilePage.tsx', mocks);
function render(scope = 'user:couple') { index = 0; tree = Ledger({ scope }); return tree; }
function nodes(n = tree) { return !n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).filter(v => v !== undefined).flatMap(nodes)]; }
function click(text) { const b = nodes().find(n => n.type === 'button' && n.props.children === text); assert.ok(b); assert.equal(!!b.props.disabled, false); b.props.onClick(); render(); }
render(); assert.equal(nodes().filter(n => n.type === LedgerRow).length, 20);
assert.equal(query.queryKey[0], 'ledger'); assert.equal(query.queryKey[2], 'user:couple');
query.queryFn({ signal }); assert.equal(requests[2][1].signal, signal);
click('Cũ hơn'); assert.equal(query.queryKey[3], 'older');
result = { data: { items: [], nextCursor: null } }; render();
assert.equal(nodes().find(n => n.type === 'EmptyState').props.title, 'Trang này không còn giao dịch');
click('Mới nhất'); assert.equal(query.queryKey[3], null);
result = { isError: true, data: { items: [{ id: 'stale' }] } }; render();
assert.ok(nodes().some(n => n.type === 'ErrorState')); assert.equal(nodes().filter(n => n.type === LedgerRow).length, 0);
render('different-scope'); assert.equal(query.queryKey[2], 'different-scope');
console.log('PASS ledger UI: 20 rows, scoped page key, signal wrapper, older/latest navigation, empty history and stale-error hiding');
