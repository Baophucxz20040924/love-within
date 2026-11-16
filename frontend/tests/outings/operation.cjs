'use strict';

// Execute the real hook and TSX callbacks with persistent hook cells; no browser/server/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
const root = path.resolve(__dirname, '../../src');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, crypto: { randomUUID }, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name} in ${relative}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const result = { outing: { id: 'outing', revision: 4 }, outcome: { operationId: 'server', replayed: false } };
function harness() {
  let generation = 'session', lockEpoch = 0, phase = 'ready', cursor = 0;
  const document = { visibilityState: 'visible' }, cells = [], effects = [], cleanups = [];
  const calls = { cache: [], state: [], sent: [], close: [], saved: [] };
  const tokenStore = { generation: () => generation, isCurrent: value => value === generation };
  const api = load('lib/apiClient.ts', { './tokenStore': { tokenStore } });
  const react = {
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    useState(initial) {
      const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; calls.state.push(index); }];
    },
    useEffect(effect) { const index = cursor++; if (!(index in cells)) { cells[index] = true; effects.push(effect); } },
  };
  const lock = { appLockEpoch: () => lockEpoch, isAppLockCurrent: value => value === lockEpoch && phase === 'ready' && document.visibilityState === 'visible' };
  const outingApi = { OUTINGS_KEY: ['friends', 'outings'], outingKey: id => ['friends', 'outing', id] };
  const qc = {
    setQueryData: (...args) => calls.cache.push(['set', ...args]),
    invalidateQueries: (...args) => { calls.cache.push(['invalidate', ...args]); return h.invalidate?.() ?? Promise.resolve(); },
  };
  const query = { useQueryClient: () => qc, useQuery: () => ({}) };
  const hook = load('features/friends/outings/useOutingOperation.ts', {
    react, '@tanstack/react-query': query, '../../../lib/apiClient': api, '../../../lib/tokenStore': { tokenStore }, '../../appLock/store': lock, './api': outingApi,
  }, { document });
  const h = {
    calls, react, query, hook, api, outingApi, lock,
    render(fn = () => hook.useOutingOperation('outing', 3)) {
      cursor = 0; const value = fn();
      for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
      return value;
    },
    conceal() { lockEpoch++; api.advanceAccessEpoch(); phase = 'loading'; document.visibilityState = 'hidden'; },
    resume() { document.visibilityState = 'visible'; phase = 'ready'; },
    changeAccess() { api.advanceAccessEpoch(); },
    changeLock() { lockEpoch++; },
    hideOnly() { document.visibilityState = 'hidden'; },
    setPhase(value) { phase = value; },
    changeSession() { generation = 'other'; },
    unmount() { cleanups.forEach(fn => fn()); },
  };
  return h;
}
function find(node, predicate) {
  if (Array.isArray(node)) { for (const child of node) { const value = find(child, predicate); if (value) return value; } }
  else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const ledger = {
  id: 'outing', title: 'Ledger', outingDate: '2026-11-16', revision: 3, financeRevision: 2, phase: 'collecting', access: 'full', myMembership: 'accepted',
  creatorId: 'me', participants: [{ userId: 'me', displayName: 'Me', status: 'accepted', consent: null }],
  balances: [], settlements: [], expenses: [], suggestions: [], totalExpenses: 0,
  capacity: Object.fromEntries(['participants', 'expenses', 'settlements', 'edits', 'ordinaryOperations', 'reservedOperations'].map(name => [name, { used: 1, max: 50 }])),
};
function formHarness(kind) {
  const h = harness(), transport = deferred();
  const send = (...args) => { h.calls.sent.push(args); return transport.promise; };
  const presentation = load('features/friends/outings/presentation.ts');
  const forms = load('features/friends/outings/OutingForms.tsx', {
    react: h.react, 'react/jsx-runtime': jsx, '@tanstack/react-query': h.query,
    '../../../components/BottomSheet': { BottomSheet: 'BottomSheet' }, '../../../components/Icon': { Icon: 'Icon' },
    '../../../lib/format': { formatVnd: String }, '../api': {}, './api': { outingsApi: { create: send, addMembers: send, expense: send, settlement: send } },
    './useOutingOperation': h.hook, './presentation': presentation, './outings.css': {},
  });
  const component = forms[kind];
  const props = { outing: ledger, myId: 'me', onClose: () => h.calls.close.push(true), onSaved: value => h.calls.saved.push(value) };
  const render = () => h.render(() => component(props));
  let tree = render();
  if (kind === 'ExpenseSheet') {
    find(tree, node => node.type === 'input' && node.props.placeholder === 'Bữa tối, cà phê, vé xem phim…').props.onChange({ target: { value: 'Expense' } });
    find(tree, node => node.type === 'input' && node.props.className.includes('outing-money-input')).props.onChange({ target: { value: '1000' } });
    tree = render();
  }
  return { h, transport, render, tree };
}

(async () => {
  let checks = 0;
  // Success resolves on either side of hide/resume, including transport already resolved before continuation.
  for (const transition of ['conceal', 'conceal-resume', 'access', 'lock', 'visibility', 'not-ready']) {
    const h = harness(), pending = deferred(); let op = h.render();
    const original = { title: 'frozen draft' };
    const send = meta => { h.calls.sent.push({ meta: plain(meta), payload: original }); return pending.promise; };
    const running = op.run(99, send);
    assert.equal(await op.run(99, send), undefined, 'double submit is ignored');
    pending.resolve(result);
    if (transition.startsWith('conceal')) { h.conceal(); if (transition.endsWith('resume')) h.resume(); }
    if (transition === 'access') h.changeAccess();
    if (transition === 'lock') h.changeLock();
    if (transition === 'visibility') h.hideOnly();
    if (transition === 'not-ready') h.setPhase('loading');
    assert.equal(await running, undefined, `${transition}: stale success must not escape`);
    assert.equal(h.calls.cache.length, 0, `${transition}: no stale cache effects`);
    op = h.render(); assert.equal(op.uncertain, true); assert.equal(op.busy, false); assert.equal(op.locked, true);
    op.reset(); assert.equal(h.render().uncertain, true, 'unknown outcome cannot be discarded');
    h.resume();
    const replay = await h.render().run(100, () => { throw new Error('must not replace captured send'); });
    assert.equal(replay.isCurrent(), true);
    assert.equal(h.calls.sent.length, 2);
    assert.deepEqual(h.calls.sent[0], h.calls.sent[1], 'retry preserves operation ID, revision and payload');
    assert.equal(h.calls.sent[0].meta.expectedRevision, 3);
    assert.equal(h.render().uncertain, false);
    checks++;
  }
  // Mount epochs are not submission epochs; untouched retained drafts work after quick return.
  {
    const h = harness(); const op = h.render(); h.conceal();
    assert.equal(await op.run(3, async () => { throw new Error('hidden dispatch'); }), undefined);
    h.resume(); const saved = await op.run(3, async () => result);
    assert.equal(saved.isCurrent(), true);
    h.conceal(); h.resume(); assert.equal(saved.isCurrent(), false, 'caller guard remains stale after ready returns');
    const fresh = await h.render().run(4, async () => result); assert.equal(fresh.isCurrent(), true);
    checks++;
  }
  for (const code of ['ACCESS_CHANGED', 'NETWORK', 'TIMEOUT']) {
    const h = harness(); let sends = 0; const metas = [];
    const send = async meta => {
      metas.push(plain(meta));
      if (++sends === 1) throw code === 'NETWORK' ? new Error('lost response') : new h.api.ApiRequestError(code === 'TIMEOUT' ? 408 : 503, code, 'unknown');
      return result;
    };
    await h.render().run(3, send); assert.equal(h.render().uncertain, true);
    await h.render().run(50, async () => { throw new Error('new payload'); });
    assert.deepEqual(metas[0], metas[1]); checks++;
  }
  // Old account/unmounted trees never update state, cache, or return a navigable success.
  for (const transition of ['changeSession', 'unmount']) {
    for (const outcome of ['resolve', 'reject']) {
      const h = harness(), pending = deferred(); const running = h.render().run(3, () => pending.promise);
      h[transition](); h.calls.state.length = 0;
      pending[outcome](outcome === 'resolve' ? result : new Error('late error'));
      assert.equal(await running, undefined); assert.equal(h.calls.cache.length, 0); assert.equal(h.calls.state.length, 0);
      checks++;
    }
  }
  // Conflict refresh introduces another await, which must not erase the original operation after conceal.
  {
    const h = harness(), refresh = deferred(); h.invalidate = () => refresh.promise;
    let sends = 0; const metas = [];
    const running = h.render().run(3, async meta => { metas.push(plain(meta)); if (++sends === 1) throw new h.api.ApiRequestError(409, 'OUTING_REVISION_CONFLICT', 'stale'); return result; });
    await tick(); h.conceal(); h.resume(); refresh.resolve(); await running;
    assert.equal(h.render().uncertain, true); assert.equal(h.render().stale, false);
    await h.render().run(100, async () => { throw new Error('replacement'); });
    assert.deepEqual(metas[0], metas[1]); checks++;
  }
  // Definite validation rejection allows a new operation, not a replay of invalid input.
  {
    const h = harness(); const metas = [];
    await h.render().run(3, async meta => { metas.push(plain(meta)); throw new h.api.ApiRequestError(400, 'INVALID', 'invalid'); });
    assert.equal(h.render().uncertain, false);
    await h.render().run(3, async meta => { metas.push(plain(meta)); return result; });
    assert.notEqual(metas[0].operationId, metas[1].operationId); checks++;
  }
  // Real form continuations: conceal/resume in the microtask gap AFTER run() succeeds.
  for (const kind of ['CreateOutingSheet', 'InviteOutingSheet', 'ExpenseSheet', 'SettlementSheet']) {
    for (const conceal of [false, true]) {
      const { h, transport, tree } = formHarness(kind);
      if (conceal) h.invalidate = () => { queueMicrotask(() => { h.conceal(); h.resume(); }); return Promise.resolve(); };
      tree.props.onSubmit(); assert.equal(h.calls.sent.length, 1, `${kind} submits`);
      transport.resolve(result); await tick();
      assert.equal(h.calls.saved.length + h.calls.close.length, conceal ? 0 : 1, `${kind}: exact attempt guards caller continuation`);
      checks++;
    }
  }
  // Legacy pending invitation still offers accept/decline; accepted membership never does.
  for (const membership of ['pending', 'accepted', 'declined']) {
    const h = harness();
    const view = membership === 'accepted' ? ledger : { ...ledger, access: membership === 'pending' ? 'invited' : 'declined', myMembership: membership };
    const page = load('pages/FriendOutingPage.tsx', {
      react: h.react, 'react/jsx-runtime': jsx,
      'react-router-dom': { Link: 'Link', useParams: () => ({ id: 'outing' }) },
      '@tanstack/react-query': { ...h.query, useQuery: () => ({ data: view }) },
      '../components/BottomSheet': { BottomSheet: 'BottomSheet' }, '../components/Icon': { Icon: 'Icon' },
      '../components/StatusViews': { Page: 'Page' }, '../features/auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'me' } } }) },
      '../lib/apiClient': h.api, '../lib/format': { formatVnd: String },
      '../features/friends/outings/api': { ...h.outingApi, outingsApi: {} },
      '../features/friends/outings/OutingForms': Object.fromEntries(['CapacityMessage', 'ExpenseSheet', 'InviteOutingSheet', 'OperationMessage', 'SettlementSheet'].map(key => [key, key]).concat([['memberName', () => 'Me']])),
      '../features/friends/outings/presentation': load('features/friends/outings/presentation.ts'),
      '../features/friends/outings/types': load('features/friends/outings/types.ts'),
      '../features/friends/outings/useOutingOperation': h.hook, '../features/friends/outings/outings.css': {},
    });
    const tree = h.render(page.FriendOutingPage);
    for (const label of ['Nhận lời tham gia', 'Từ chối']) {
      assert.equal(Boolean(find(tree, node => node.type === 'button' && node.props.children === label)), membership === 'pending', `${membership}/${label}`);
    }
    checks++;
  }
  console.log(`PASS ${checks} outing operation and actual form/legacy UI scenarios (mocked React hooks/query, actual TypeScript).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
