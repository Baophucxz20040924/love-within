'use strict';

// Pure component-callback tests: no renderer, browser, server, database or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Worktrees can reuse the original checkout's installed TypeScript without a link
// or install. Only dependencies are resolved outside this worktree, never sources.
function resolveTypeScript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = resolveTypeScript();
const sourceRoot = path.resolve(__dirname, '../src');

function loadSource(relative, mocks) {
  const filename = path.join(sourceRoot, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name} in ${relative}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

function harness(kind) {
  let generation = 'mount-session';
  let cursor = 0;
  const cells = [];
  const effects = [];
  const mutations = [];
  const calls = { toast: [], close: [], cache: [], api: [], mutate: [], state: [] };
  const tokenStore = { generation: () => generation, isCurrent: (value) => generation === value };
  const apiClient = loadSource('lib/apiClient.ts', { './tokenStore': { tokenStore } });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (value) => {
        cells[index] = typeof value === 'function' ? value(cells[index]) : value;
        calls.state.push(index);
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in cells)) {
        cells[index] = true;
        effects.push(effect);
      }
    },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const goal = { id: 'goal-1', title: 'Test', emoji: '', status: 'active', pinned: false };
  const entry = { id: 'entry-1', isMine: true, amountVnd: 100, occurredOn: '2026-01-01' };
  const txn = { id: 'txn-1', note: 'original', direction: 'out', amount: 100, occurredAt: '2026-01-01T00:00:00Z' };
  const dispatch = (name) => (...args) => { calls.api.push([name, ...args]); return Promise.resolve({ note: 'saved' }); };
  const qc = { invalidateQueries: async (options) => { calls.cache.push(options); } };
  const toast = { success: (...args) => calls.toast.push(['success', ...args]), error: (...args) => calls.toast.push(['error', ...args]) };
  const query = {
    useQueryClient: () => qc,
    useInfiniteQuery: () => ({ data: { pages: [{ goal, entries: [entry] }] } }),
    useMutation(options) {
      const index = cursor++;
      if (!(index in cells)) {
        cells[index] = { options, mutate: (...args) => calls.mutate.push(args), reset() {} };
        mutations.push(cells[index]);
      }
      cells[index].options = options;
      return cells[index];
    },
  };
  const mocks = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-router-dom': { Link: 'Link', useParams: () => ({ id: goal.id }) },
    '@tanstack/react-query': query,
  };
  const prefix = kind === 'savings' ? '../' : '../../';
  mocks[prefix + 'components/BottomSheet'] = { BottomSheet: 'BottomSheet' };
  mocks[prefix + 'components/Toast'] = { useToast: () => toast };
  mocks[prefix + 'lib/apiClient'] = apiClient;
  mocks[prefix + 'lib/tokenStore'] = { tokenStore };
  mocks[prefix + 'lib/format'] = Object.fromEntries(['formatDay', 'formatNetVnd', 'formatDate', 'formatSignedVnd', 'formatTime'].map((key) => [key, () => 'formatted']));
  if (kind === 'savings') {
    mocks['../components/StatusViews'] = Object.fromEntries(['EmptyState', 'ErrorState', 'Page', 'Skeleton'].map((key) => [key, key]));
    mocks['../features/questions/useCouplePeople'] = { useCouplePeople: () => ({ partnerName: 'Partner' }) };
    mocks['../features/savings/api'] = {
      savingsDetailKey: (id) => ['savings', id],
      savingsError: () => 'error',
      refreshSavings: async () => { calls.cache.push('refreshSavings'); },
      savingsApi: { pin: dispatch('pin'), removeEntry: dispatch('removeEntry') },
    };
    mocks['../features/savings/SavingsSheets'] = { SavingsEntrySheet: 'SavingsEntrySheet', SavingsGoalSheet: 'SavingsGoalSheet' };
    mocks['../features/savings/SavingsViews'] = { SavingsCelebration: 'SavingsCelebration', SavingsMembers: 'SavingsMembers', SavingsProgress: 'SavingsProgress' };
  } else {
    mocks['./api'] = { financeApi: { setNote: dispatch('setNote') }, financeOwnerKey: (owner) => ['finance', owner] };
    mocks['../savings/SavingsSheets'] = { BankSavingsAction: 'BankSavingsAction' };
  }
  const Component = kind === 'savings'
    ? loadSource('pages/SavingsDetailPage.tsx', mocks).SavingsDetailPage
    : loadSource('features/finance/NoteSheet.tsx', mocks).NoteSheet;
  function render() {
    cursor = 0;
    return Component({ txn, onClose: () => calls.close.push('close') });
  }
  let tree = render();
  const cleanups = effects.map((effect) => effect()).filter(Boolean);
  tree = render();
  // Select the actual deletion target before capturing the remove mutation.
  if (kind === 'savings') {
    find(tree, (node) => node.props['aria-label']?.startsWith('Xóa khoản')).props.onClick();
    tree = render();
  }
  function clear() { for (const records of Object.values(calls)) records.length = 0; }
  clear();
  return {
    calls, mutations, tree, apiClient, clear, render,
    changeSession: () => { generation = 'new-session'; render(); },
    unmount: () => cleanups.forEach((cleanup) => cleanup()),
  };
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
  } else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
  return undefined;
}
function noEffects(h, label) {
  for (const [key, records] of Object.entries(h.calls)) assert.equal(records.length, 0, `${label}: unexpected ${key}`);
}

(async () => {
  let checks = 0;
  for (const kind of ['savings', 'note']) {
    const count = kind === 'savings' ? 2 : 1;
    for (let index = 0; index < count; index++) {
      for (const state of ['current', 'changed', 'unmounted']) {
        for (const outcome of ['onSuccess', 'onError']) {
          const h = harness(kind);
          // Capture callbacks before rerendering into another generation.
          const callback = h.mutations[index].options[outcome];
          if (state === 'changed') h.changeSession();
          if (state === 'unmounted') h.unmount();
          h.clear();
          await callback(outcome === 'onSuccess' ? { note: 'saved' } : new h.apiClient.ApiRequestError(400, 'TEST', 'Test error'));
          if (state !== 'current') noEffects(h, `${kind}/${index}/${state}/${outcome}`);
          else if (kind === 'note' && outcome === 'onError') assert.equal(h.calls.state.length, 1);
          else {
            assert.equal(h.calls.toast.length, 1);
            assert.equal(h.calls.cache.length, 1);
            assert.equal(h.calls.close.length, kind === 'note' ? 1 : 0);
          }
          checks++;
        }
      }
      for (const state of ['current', 'changed']) {
        const h = harness(kind);
        const mutationFn = h.mutations[index].options.mutationFn;
        if (state === 'changed') h.changeSession();
        h.clear();
        if (state === 'changed') {
          assert.throws(() => mutationFn('new note'), (error) => error.code === 'SESSION_CHANGED');
          noEffects(h, `${kind}/${index}/predispatch`);
        } else {
          await mutationFn('new note');
          assert.equal(h.calls.api.length, 1);
          assert.equal(h.calls.api[0][0], kind === 'note' ? 'setNote' : index === 0 ? 'pin' : 'removeEntry');
        }
        checks++;
      }
    }
  }
  for (const state of ['current', 'changed', 'unmounted']) {
    const h = harness('note');
    const submit = find(h.tree, (node) => node.type === 'form').props.onSubmit;
    if (state === 'changed') h.changeSession();
    if (state === 'unmounted') h.unmount();
    h.clear();
    let prevented = false;
    submit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    if (state === 'current') {
      assert.equal(h.calls.mutate.length, 1);
      assert.equal(h.calls.mutate[0][0], 'original');
    } else noEffects(h, `note/${state}/submit`);
    checks++;
  }
  console.log(`PASS: ${checks} isolated session-mutation scenarios (actual TSX and session assertion; mocked hooks/query/API).`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
