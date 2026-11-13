'use strict';

// Transpile the actual component; mock hooks, queries and API. No browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
for (let dir = __dirname; ; dir = path.dirname(dir)) {
  try { ts = require(require.resolve('typescript', { paths: [path.join(dir, 'frontend'), dir] })); break; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
}
const filename = path.resolve(__dirname, '../src/pages/FinancePage.tsx');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(initialLinked = true) {
  let generation = 'old', linked = initialLinked, cursor = 0, resolve;
  const cells = [], effects = [], calls = { sync: 0, cache: [], invalidate: [] };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], () => {}]; },
    useRef(initial) { const i = cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
    useEffect(fn, deps) {
      const i = cursor++, previous = cells[i];
      if (!previous || deps.some((dep, n) => dep !== previous.deps[n])) {
        const record = { fn, deps, cleanup: previous?.cleanup };
        cells[i] = record;
        effects.push(record);
      }
    },
  };
  const tokenStore = { generation: () => generation, isCurrent: (value) => value === generation };
  const qc = { setQueryData: (...args) => calls.cache.push(args), invalidateQueries: (...args) => calls.invalidate.push(args) };
  const financeApi = { sync: () => { calls.sync++; return new Promise((r) => { resolve = r; }); } };
  const mocks = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-router-dom': { Link: 'Link' },
    '@tanstack/react-query': { useQueryClient: () => qc, useQuery: () => ({ data: { linked } }) },
    '../features/auth/AuthContext': { useAuth: () => ({ me: null }) },
    '../features/finance/api': { FINANCE_CONNECTION_KEY: ['finance', 'connection'], financeOwnerKey: (owner) => ['finance', owner], financeApi },
    '../lib/tokenStore': { tokenStore }, '../lib/format': { localDateOf: () => '2026-11-13' },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require(name) { return mocks[name] ?? {}; } }, { filename });
  const render = () => { cursor = 0; module.exports.FinancePage(); };
  const flush = () => { while (effects.length) { const effect = effects.shift(); effect.cleanup?.(); effect.cleanup = effect.fn(); } };
  const cleanup = () => { for (const cell of cells) if (cell && typeof cell.cleanup === 'function') cell.cleanup(); };
  return { calls, render, flush, cleanup, change: () => { generation = 'new'; }, link: () => { linked = true; },
    replay: () => { cleanup(); for (const cell of cells) if (cell && typeof cell.fn === 'function') cell.cleanup = cell.fn(); },
    finish: async (inserted = 1) => { resolve({ connection: { linked: true }, inserted }); await Promise.resolve(); await Promise.resolve(); } };
}

(async () => {
  for (const state of ['current', 'changed', 'unmounted', 'strict']) {
    const h = harness(); h.render(); h.flush();
    if (state === 'changed') h.change();
    if (state === 'unmounted') h.cleanup();
    if (state === 'strict') h.replay();
    await h.finish();
    assert.equal(h.calls.sync, 1, state);
    assert.equal(h.calls.cache.length, state === 'current' || state === 'strict' ? 1 : 0, state);
    assert.equal(h.calls.invalidate.length, state === 'current' || state === 'strict' ? 1 : 0, state);
  }
  const changed = harness(); changed.render(); changed.change(); changed.flush(); assert.equal(changed.calls.sync, 0);
  const late = harness(false); late.render(); late.flush(); assert.equal(late.calls.sync, 0); late.link(); late.render(); late.flush(); assert.equal(late.calls.sync, 1); await late.finish(0); assert.equal(late.calls.cache.length, 1); assert.equal(late.calls.invalidate.length, 0);
  const unmounted = harness(false); unmounted.render(); unmounted.flush(); unmounted.cleanup(); unmounted.link(); unmounted.render(); unmounted.flush(); assert.equal(unmounted.calls.sync, 0);
  console.log('PASS: 7 isolated FinancePage bootstrap scenarios (actual TSX; mocked hooks/query/API).');
})().catch((error) => { console.error(error); process.exitCode = 1; });
