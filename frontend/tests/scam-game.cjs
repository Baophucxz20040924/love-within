'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { randomUUID } = require('node:crypto');
function load(file, mocks, extra = {}) {
  const filename = path.resolve(__dirname, '../src', file), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, ...extra, require(name) { assert(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
let states = [], refs = [], effects = [], si, ri, ei, pendingEffects = [];
const react = {
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  useState(v) { const i = si++; if (!(i in states)) states[i] = typeof v === 'function' ? v() : v; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
  useRef(v) { return refs[ri++] ??= { current: v }; }, useId: () => 'drawer',
  useEffect(fn, deps) { const i = ei++, previous = effects[i]; if (!previous || deps.some((d, j) => d !== previous.deps[j])) pendingEffects.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
};
const jsx = (type, props) => ({ type, props });
function nodes(n) { return !n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(n) { return !n || typeof n !== 'object' ? String(n ?? '') : [n.props?.children].flat(Infinity).map(text).join(''); }
function reset() { effects.forEach(e => e.cleanup?.()); states = []; refs = []; effects = []; pendingEffects = []; }
function render(fn, props) { si = ri = ei = 0; const tree = fn(props); pendingEffects.splice(0).forEach(fn => fn()); return tree; }
const calls = [];
const wrappers = load('features/scam/api.ts', { '../../lib/apiClient': { apiRequest: (...args) => calls.push(args) } });
const signal = new AbortController().signal, operation = { operationId: 'op', expectedRevision: 3, matchId: 'match' };
wrappers.scamApi.state(signal); wrappers.scamApi.board('a/b c', signal);
assert.equal(calls[0][1].signal, signal); assert.equal(calls[1][0], '/friends/scam/leaderboard?limit=20&cursor=a%2Fb%20c');
wrappers.scamApi.start(operation); wrappers.scamApi.message(operation, 'draft'); wrappers.scamApi.verify(operation, 'otp', '001234'); wrappers.scamApi.stop(operation);
assert(calls.slice(2).every(c => c[1].timeoutMs === 90000)); assert.equal(calls[2][1].body.consent, true); assert.equal(calls[4][1].body.value, '001234');
assert.equal(wrappers.scamKey('u').join('/'), 'friends/scam/u');
const { ScamEntryCard } = load('features/scam/ScamEntryCard.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { Link: 'Link' }, '../../components/Icon': { Icon: 'Icon' }, './scam-entry.css': {} });
const entry = ScamEntryCard();
assert.equal(entry.type, 'Link'); assert.equal(entry.props.to, '/friends/scam'); assert(text(entry).includes('Chơi ngay'));
assert(!nodes(entry).some(n => n.type === 'button'), 'entry has no nested interactive control or game/API dependency');
const themeListeners = new Set(); let theme, cleanupTheme;
const themeHook = load('features/friends/useFriendsTheme.ts', { react: { useLayoutEffect: fn => { cleanupTheme = fn(); } }, '../appLock/store': { setAppTheme: v => { theme = v; }, subscribeAppLock: fn => { themeListeners.add(fn); return () => themeListeners.delete(fn); } } });
themeHook.useFriendsTheme(true); assert.equal(theme, true);
theme = false; themeListeners.forEach(fn => fn()); assert.equal(theme, true, 'bootstrap presentation reset reapplies requested Friends palette');
cleanupTheme(); assert.equal(theme, false); assert.equal(themeListeners.size, 0);
const outgoingHelpers = load('features/scam/outgoing.ts', {});
class ApiRequestError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const { SecretDrawer } = load('features/scam/SecretDrawer.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx } });
async function tests() {
  reset(); let verified;
  const match = { id: 'match', stage: 'otp', status: 'active', revealed: ['account', 'password', 'otp'] };
  const props = { match, busy: false, onVerify: async (...args) => { verified = args; return false; } };
  let tree = render(SecretDrawer, props), handle = () => nodes(tree).find(n => n.type === 'button');
  assert.equal(handle().props['aria-expanded'], false);
  handle().props.onClick(); tree = render(SecretDrawer, props); assert.equal(handle().props['aria-expanded'], true);
  const otp = () => nodes(tree).find(n => n.type === 'input' && n.props.inputMode === 'numeric');
  assert.equal(otp().props.type, 'text'); otp().props.onChange({ target: { value: '001234' } }); tree = render(SecretDrawer, props);
  await nodes(tree).filter(n => n.type === 'form')[2].props.onSubmit({ preventDefault() {} }); tree = render(SecretDrawer, props); assert.equal(otp().props.value, '001234'); assert.equal(verified[1], '001234');
  let captures = 0; const target = { setPointerCapture() { captures++; }, hasPointerCapture: () => true, releasePointerCapture() { captures--; } };
  handle().props.onPointerDown({ button: 0, clientY: 100, pointerId: 1, currentTarget: target }); handle().props.onPointerMove({ clientY: 150 }); handle().props.onPointerUp({ pointerId: 1, currentTarget: target }); handle().props.onClick(); tree = render(SecretDrawer, props);
  assert.equal(handle().props['aria-expanded'], false); assert.equal(captures, 0); assert.equal(otp().props.value, '001234');
  handle().props.onPointerDown({ button: 0, clientY: 100, pointerId: 1, currentTarget: target }); handle().props.onPointerCancel(); handle().props.onClick(); tree = render(SecretDrawer, props); assert.equal(handle().props['aria-expanded'], true);
  reset();
  const unlocked = { ...props, match: { ...match, stage: 'account', revealed: [] }, busy: true };
  tree = render(SecretDrawer, unlocked);
  assert(nodes(tree).filter(n => n.type === 'input' && n.props.name).every(n => n.props.readOnly === false), 'all unfinished fields editable while pending');
  assert(nodes(tree).filter(n => n.type === 'button' && n.props.type === 'submit').every(n => n.props.disabled));
  nodes(tree).find(n => n.type === 'input' && n.props.name === 'prop-account').props.onChange({ target: { value: 'account' } });
  tree = render(SecretDrawer, { ...unlocked, busy: false });
  const verifies = nodes(tree).filter(n => n.type === 'button' && n.props.type === 'submit');
  assert.equal(verifies[0].props.disabled, false); assert.equal(verifies[1].props.disabled, true);
  tree = render(SecretDrawer, { ...unlocked, match: { ...unlocked.match, status: 'lost' } });
  assert(nodes(tree).filter(n => n.type === 'input' && n.props.name).every(n => n.props.readOnly));
  reset();
  let state = { revision: 1, bestScore: 0, wins: 0, mock: true, recentOperations: [], pending: null, match: { ...match, stage: 'account', character: { name: 'Alice', emoji: '🐇', description: 'Tò mò' }, trust: 20, score: 0, turns: 0, messages: [] } };
  let postResolve, sends = 0, epoch = 0, generation = 'session', reads = 0;
  const api = {
    state: async () => { reads++; return structuredClone(state); },
    message: (op, draft) => { sends++; return new Promise(resolve => { postResolve = () => { state.revision += 2; state.recentOperations.push(op.operationId); resolve(structuredClone(state)); }; }); },
  };
  const page = load('features/scam/ScamGamePage.tsx', { '../realtime/verification': { subscribeVerification: () => () => {} }, '../appLock/store': { subscribeAppLock: () => () => {} }, react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { Link: 'Link' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {} }) }, '../auth/AuthContext': { useAuth: () => ({ me: { user: { id: 'u' } } }) },
    '../../lib/apiClient': { ApiRequestError, currentAccessEpoch: () => epoch }, '../../lib/tokenStore': { tokenStore: { generation: () => generation } },
    './outgoing': outgoingHelpers, './api': { scamApi: api, scamKey: wrappers.scamKey }, './SecretDrawer': { SecretDrawer: 'Drawer', stageLabels: { account: 'Tài khoản', password: 'Password', otp: 'OTP' } }, './ScamLeaderboard': { ScamLeaderboard: 'Board' }, './scam.css': {},
  }, { window: { confirm: () => true, matchMedia: () => ({ matches: true }) } });
  const boundary = page.ScamGamePage(); const room = boundary.type, roomProps = boundary.props;
  tree = render(room, roomProps); await new Promise(r => setImmediate(r)); tree = render(room, roomProps); assert.equal(reads, 1);
  const meters = nodes(tree).filter(n => n.props?.label === 'Tin tưởng' || n.props?.label === 'Cảnh giác');
  assert.equal(meters.length, 1); assert.equal(meters[0].props.label, 'Tin tưởng');
  assert(!nodes(tree).some(n => n.props?.className === 'scam-warning'));
  const input = () => nodes(tree).find(n => n.type === 'textarea'); const form = () => nodes(tree).find(n => n.type === 'form');
  input().props.onChange({ target: { value: 'bản nháp' } }); tree = render(room, roomProps);
  form().props.onSubmit({ preventDefault() {} }); form().props.onSubmit({ preventDefault() {} }); assert.equal(sends, 1);
  tree = render(room, roomProps); assert.equal(input().props.value, '');
  assert(nodes(tree).some(n => n.props?.['data-status'] === 'sending' && text(n).includes('bản nháp')), 'bubble appears before POST resolves');
  input().props.onChange({ target: { value: 'nháp mới' } }); tree = render(room, roomProps);
  postResolve(); await new Promise(r => setImmediate(r)); tree = render(room, roomProps); assert.equal(input().props.value, 'nháp mới');
  assert(!nodes(tree).some(n => n.props?.['data-status']), 'receipt removes transient bubble');
  // An uncertain acknowledgement is reconciled before retry, without resending.
  api.message = async op => { sends++; state.revision += 2; state.recentOperations.push(op.operationId); throw Error('lost acknowledgement'); };
  input().props.onChange({ target: { value: 'đã lưu nhưng timeout' } }); tree = render(room, roomProps); form().props.onSubmit({ preventDefault() {} }); await new Promise(r => setImmediate(r)); tree = render(room, roomProps); assert.equal(input().props.value, ''); assert.equal(sends, 2); assert.equal(reads, 2);
  // Explicit failure retains the sent snapshot, and newer drafts remain untouched.
  api.message = async () => { throw new ApiRequestError(503, 'SCAM_AI_UNAVAILABLE', 'provider fail'); };
  input().props.onChange({ target: { value: 'giữ lại' } }); tree = render(room, roomProps); form().props.onSubmit({ preventDefault() {} }); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  assert.equal(input().props.value, ''); assert(nodes(tree).some(n => n.props?.['data-status'] === 'failed' && text(n).includes('giữ lại')));
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Sửa tin nhắn').props.onClick(); tree = render(room, roomProps); assert.equal(input().props.value, 'giữ lại');
  // Late access response cannot apply; the next valid GET settles by operation ID.
  let heldOp;
  api.message = op => new Promise(resolve => { heldOp = op; postResolve = () => resolve({ ...state, revision: 99, recentOperations: [op.operationId] }); });
  form().props.onSubmit({ preventDefault() {} }); tree = render(room, roomProps);
  input().props.onChange({ target: { value: 'nháp sau đổi quyền' } });
  epoch++; roomProps.access = epoch; tree = render(room, roomProps);
  postResolve(); await new Promise(r => setTimeout(r, 5)); tree = render(room, roomProps);
  assert.equal(input().props.value, 'nháp sau đổi quyền'); assert(nodes(tree).some(n => n.props?.['data-status'] === 'uncertain'));
  state.revision += 2; state.recentOperations.push(heldOp.operationId);
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Đồng bộ ván').props.onClick(); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  assert(!nodes(tree).some(n => n.props?.['data-status']));
  api.message = async op => { state.revision += 2; state.recentOperations.push(op.operationId); return structuredClone(state); };
  form().props.onSubmit({ preventDefault() {} }); await new Promise(r => setImmediate(r)); tree = render(room, roomProps); assert.equal(input().props.value, '', 'new action works after epoch reconciliation');
  // Show uncertainty before a slow/failed GET, then reject an older snapshot.
  const normalRead = api.state; let readReject;
  api.state = () => new Promise((_resolve, reject) => { readReject = reject; });
  api.message = async () => { throw Error('unknown outcome'); };
  input().props.onChange({ target: { value: 'uncertain snapshot' } }); tree = render(room, roomProps); form().props.onSubmit({ preventDefault() {} });
  await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  assert(nodes(tree).some(n => n.props?.['data-status'] === 'uncertain'));
  assert(nodes(tree).some(n => n.props?.className === 'scam-send-feedback'));
  readReject(Error('offline')); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  api.state = async () => ({ ...state, revision: state.revision - 1, recentOperations: [] });
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Đồng bộ ván').props.onClick(); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  assert(nodes(tree).some(n => n.props?.['data-status'] === 'uncertain'));
  assert(nodes(tree).find(n => n.type === 'button' && text(n) === 'Gửi').props.disabled);
  api.state = normalRead;
  // A terminal state settles uncertainty without reposting the message.
  state.revision++; state.match.status = 'stopped';
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Đồng bộ ván').props.onClick(); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  assert(!nodes(tree).some(n => n.props?.['data-status']));
  state.revision++; state.match.status = 'active';
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Đồng bộ ván').props.onClick(); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  const turn = { operation: { operationId: 'missing', expectedRevision: state.revision, matchId: state.match.id }, text: 'same', status: 'uncertain' };
  assert.equal(outgoingHelpers.reconcileOutgoing(turn, state).status, 'uncertain');
  assert.equal(outgoingHelpers.reconcileOutgoing({ ...turn, rejected: true }, state).status, 'failed');
  assert.equal(outgoingHelpers.reconcileOutgoing({ ...turn, rejected: true }, { ...state, revision: state.revision + 20 }).status, 'uncertain', 'receipt eviction is not proof of failure');
  assert.equal(outgoingHelpers.reconcileOutgoing(turn, { ...state, match: { ...state.match, messages: [{ role: 'user', text: 'same', operationId: 'different' }] } }).status, 'uncertain', 'identical text is not correlation');
  assert.equal(outgoingHelpers.reconcileOutgoing(turn, { ...state, match: { ...state.match, messages: [{ operationId: 'missing' }] } }), null);
  const pendingState = { ...state, pending: { operationId: 'pending', expectedRevision: 7, expiresAt: 0, text: 'held' } };
  const recovered = outgoingHelpers.reconcileOutgoing(null, pendingState);
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.operation.expectedRevision, 7);
  assert.equal(outgoingHelpers.reconcileOutgoing(recovered, state).status, 'uncertain');
  const progress = () => nodes(tree).find(n => n.props?.className === 'scam-progress');
  let steps = nodes(progress()).filter(n => n.type === 'li');
  assert.equal(steps[0].props['aria-current'], 'step');
  assert(!steps.some(n => n.props.className === 'is-done'), 'revealed props do not count as confirmed stages');
  async function refresh() {
    nodes(tree).find(n => n.type === 'button' && text(n) === 'Đồng bộ ván').props.onClick();
    await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  }
  state.revision++; state.match.stage = 'password'; await refresh();
  steps = nodes(progress()).filter(n => n.type === 'li');
  assert.equal(steps[0].props.className, 'is-done'); assert.equal(steps[1].props['aria-current'], 'step'); assert.equal(steps[2].props.className, '');
  for (const status of ['won', 'lost', 'stopped']) {
    state.revision++; state.match.status = status; state.match.score = status === 'won' ? 600 : 100; await refresh();
    assert(nodes(tree).some(n => n.props?.className === `scam-result scam-result--${status}`));
    assert(!nodes(tree).some(n => n.type === 'textarea'), 'terminal chat is read-only');
    steps = nodes(progress()).filter(n => n.type === 'li');
    assert.equal(steps.filter(n => n.props.className === 'is-done').length, status === 'won' ? 3 : 1);
    assert(!steps.some(n => n.props['aria-current']), 'terminal progress has no active step');
  }
  reset(); state = { ...state, revision: 0, match: null }; let starts = 0;
  api.start = async () => { starts++; return structuredClone(state); };
  tree = render(room, roomProps); await new Promise(r => setImmediate(r)); tree = render(room, roomProps);
  const startButton = () => nodes(tree).find(n => n.type === 'button' && text(n) === 'Bắt đầu trò chuyện');
  assert.equal(starts, 0, 'opening the route never starts a game'); assert.equal(startButton().props.disabled, true);
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = render(room, roomProps); assert.equal(startButton().props.disabled, false); assert.equal(starts, 0, 'consent alone does not start a game');
  reset();
  let boardResult = { isSuccess: true, data: { pages: [{ items: [{ player: { id: 'u', displayName: 'Người chơi' }, bestScore: 600, wins: 2, rank: 1 }], nextCursor: 'next' }] }, hasNextPage: true };
  let query;
  const boardUI = load('features/scam/ScamLeaderboard.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx }, '@tanstack/react-query': { useInfiniteQuery: o => { query = o; return boardResult; } }, '../../components/Avatar': { Avatar: 'Avatar' }, './api': { scamApi: { board() {} }, scamKey: wrappers.scamKey } });
  tree = boardUI.ScamLeaderboard({ userId: 'u' }); assert.equal(query.queryKey.join('/'), 'friends/scam/u/board'); assert(text(tree).includes('600')); assert(text(tree).includes('2 ván thắng'));
  boardResult = { ...boardResult, isError: true, isSuccess: false }; tree = boardUI.ScamLeaderboard({ userId: 'u' }); assert(!text(tree).includes('Người chơi'), 'hide cached private board on failed revalidation');
  console.log('PASS scam UI: entry route, consent/no auto-start, confirmed-stage progress/results, wrappers, scoped keys, drawer click/drag/cancel, OTP zeros, draft retention, duplicate guard, uncertain-write GET reconciliation and late access/session fences');
}
tests().catch(e => { reset(); console.error(e); process.exitCode = 1; });
