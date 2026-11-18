'use strict';
// Pure presentation and parent-retention checks; no DOM, API, DB or provider.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const format = { formatNumber: String, formatDay: s => s.split('-').reverse().join('/'), formatTime: String, timeAgo: () => 'today', monthLabel: String, dayHeading: String };
const cells = [], effects = [], cleanups = [];
let cursor = 0, generation = 'A', discard = false, listener;
const react = {
  useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], v => cells[i] = typeof v === 'function' ? v(cells[i]) : v]; },
  useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
  useEffect(fn, deps) { const i = cursor++; if (!(i in cells) || deps.some((v, j) => v !== cells[i][j])) { cells[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
};
function load(file, extras = {}, exports = []) {
  const source = fs.readFileSync(path.join(root, file), 'utf8') + (exports.length ? `\nexport { ${exports.join(',')} };` : '');
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, Date, window: { addEventListener() {}, removeEventListener() {} }, require(name) {
    if (extras[name]) return extras[name];
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name.endsWith('/format')) return format;
    if (name.endsWith('/tokenStore')) return { tokenStore: { generation: () => generation, isCurrent: g => g === generation } };
    if (name.endsWith('/appLock/store')) return { appLockState: () => ({ discard }), subscribeAppLock: fn => { listener = fn; return () => {}; }, appLockEpoch: () => 0 };
    return new Proxy({}, { get: (_, key) => key });
  } }, { filename: file });
  return mod.exports;
}
function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node?.props) return text(node.props.children); return node == null ? '' : String(node); }
function render(fn, props) { cursor = 0; const tree = fn(props); while (effects.length) effects.shift()(); return tree; }
function reset() { cells.length = 0; effects.length = 0; cleanups.length = 0; cursor = 0; generation = 'A'; discard = false; }
function find(node, predicate) { if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } } else if (node?.props) { if (predicate(node)) return node; return find(node.props.children, predicate); } }
let count = 0;
function test(name, fn) { fn(); console.log('PASS ' + name); count++; }
const q = load('pages/QuestsPage.tsx');
const reward = { policyVersion: 2, effectiveDate: '2026-11-18', localDate: '2026-11-18', status: 'waiting', baseCoin: 5, bonusCoin: 0, coinAwarded: 0, commonStreak: null };
const status = { checkedInToday: false, partnerCheckedIn: false, streak: 9, reward };
test('first check-in waits for pair without claiming coins', () => {
  assert.match(text(q.CheckinReward({ status: { ...status, checkedInToday: true } })), /Chờ người ấy/);
  const message = q.checkinSuccessMessage({ reward, coinAwarded: 0, expAwarded: 5 });
  assert.match(message, /Chờ cả hai/); assert.match(message, /\+5 EXP/); assert.doesNotMatch(message, /Đã cộng/);
});
test('pair day three shows personal 5+2=7', () => {
  const r = { ...reward, status: 'awarded', bonusCoin: 2, coinAwarded: 7, commonStreak: 3 };
  const copy = text(q.CheckinReward({ status: { ...status, reward: r } }));
  assert.match(copy, /5 cơ bản \+ 2 thưởng chuỗi = 7 Xu của bạn/); assert.match(copy, /Đã cộng 7/); assert.doesNotMatch(copy, /14 Xu/);
});
test('pending settlement never says paid', () => {
  const copy = text(q.CheckinReward({ status: { ...status, reward: { ...reward, status: 'pending', commonStreak: 2, bonusCoin: 1 } } }));
  assert.match(copy, /đang xử lý/); assert.doesNotMatch(copy, /Đã cộng/);
});
test('legacy status does not fabricate zero or double old amounts', () => {
  const copy = text(q.CheckinReward({ status: { ...status, checkedInToday: true, reward: { ...reward, policyVersion: 1, status: 'legacy' } } }));
  assert.match(copy, /chính sách cũ/); assert.match(copy, /18\/11\/2026/); assert.doesNotMatch(copy, /Đã nhận 0|5 cơ bản/);
  assert.match(q.checkinSuccessMessage({ coinAwarded: 14, expAwarded: 5, reward: { ...reward, policyVersion: 1 } }), /\+14 Xu/);
});
test('new activity quests have zero coins; legacy and water unchanged', () => {
  for (const type of ['checkin', 'duo_moment']) {
    const v = { type, rewardPolicy: { version: 2 }, coinReward: 0, expReward: 5 };
    assert.match(text(q.RewardChips({ q: v })), /0 Xu từ nhiệm vụ.*5 EXP chung/);
    assert.equal(q.isActivityExpQuest({ ...v, rewardPolicy: { version: 1 } }), false);
  }
  assert.match(text(q.RewardChips({ q: { type: 'water_goal', rewardPolicy: { version: 2 }, coinReward: 20, expReward: 10 } })), /20 Xu tổng/);
});
const p = load('pages/ProfilePage.tsx');
const entry = { id: 'one', delta: 14, type: 'coin', reason: 'checkin', scope: 'personal', createdAt: '2026-11-18' };
test('historical ledger renders actual +14, not inferred +28', () => {
  const copy = text(p.LedgerRow({ entry })); assert.match(copy, /\+14 Xu/); assert.doesNotMatch(copy, /28/); assert.equal(p.LedgerRewardDetail({ entry }), null);
});
test('provenance labels reward day and components without changing delta', () => {
  const e = { ...entry, delta: 6, provenance: { source: 'checkin', policyVersion: 2, localDate: '2026-11-18', component: 'checkin_pair', baseCoin: 5, bonusCoin: 1, commonStreak: 2 } };
  assert.match(text(p.LedgerRow({ entry: e })), /Điểm danh đủ đôi.*\+6 Xu/);
  assert.match(text(p.LedgerRewardDetail({ entry: e })), /18\/11\/2026.*5 cơ bản \+ 1 thưởng chuỗi.*2 ngày/);
});
test('zero delta is not displayed as negative', () => assert.doesNotMatch(text(p.LedgerRow({ entry: { ...entry, delta: 0 } })), /−0/));
const views = { useMomentNow: () => Date.parse('2026-11-19T00:00Z'), canCapture: () => false, CaptureButton: 'Capture', MomentTimer: 'Timer', MomentPair: 'Pair', MomentRewardStatus: 'Reward' };
const m = load('pages/MomentsPage.tsx', { '../features/moments/MomentViews': views }, ['SessionPanel', 'DayPanel']);
const session = { sessionId: 's', localDate: '2026-11-18', scheduleVersion: 3, state: 'open', closed: false, promptAt: '2026-11-18T12:00Z', rewardEndsAt: '2026-11-18T12:30Z', closesAt: '2026-11-19T00:00Z', partner: { posted: false } };
test('closed v3 keeps capture mounted with CTA disabled and reward forwarded', () => {
  const tree = render(m.SessionPanel, { session, reward, partnerName: 'Partner' });
  const capture = find(tree, n => n.type === 'Capture');
  assert.ok(capture); assert.equal(capture.props.available, false); assert.equal(capture.props.reward, reward); assert.equal(find(tree, n => n.type === 'Reward').props.reward, reward);
});
test('legacy session has no capture', () => assert.equal(find(render(m.SessionPanel, { session: { ...session, scheduleVersion: 2 }, partnerName: 'Partner' }), n => n.type === 'Capture'), undefined));
test('new moment day says 10 base +10 pair, not legacy total40', () => {
  const copy = text(render(m.DayPanel, { day: { localDate: session.localDate, scheduleVersion: 3, sessions: [], reward }, partnerName: 'P' }));
  assert.match(copy, /10 Xu cơ bản.*thêm 10 Xu\/người/); assert.doesNotMatch(copy, /40 Xu/);
});
const h = load('pages/HomePage.tsx', {}, ['HomeMoment']);
const pulse = { ...session, windowEndsAt: session.rewardEndsAt, partnerPosted: false };
reset();
test('Home retains component key and exact pending source across midnight/posted', () => {
  const before = render(h.HomeMoment, { moment: pulse }); before.props.onPendingChange(true);
  const midnight = render(h.HomeMoment, { moment: { ...pulse, localDate: '2026-11-19', sessionId: null, state: 'waiting' } });
  assert.equal(midnight.key, before.key); assert.equal(midnight.props.moment, pulse);
  const posted = render(h.HomeMoment, { moment: { ...pulse, state: 'posted' } });
  assert.equal(posted.key, before.key); assert.equal(posted.props.moment.state, 'posted');
  posted.props.onPendingChange(false); assert.equal(render(h.HomeMoment, { moment: { ...pulse, state: 'posted' } }), null);
});
reset();
test('Home clears pending state on PIN and account invalidation', () => {
  const before = render(h.HomeMoment, { moment: pulse }); before.props.onPendingChange(true);
  discard = true; listener(); assert.equal(render(h.HomeMoment, { moment: null }), null);
  discard = false; const again = render(h.HomeMoment, { moment: pulse }); again.props.onPendingChange(true);
  generation = 'B'; listener(); assert.equal(render(h.HomeMoment, { moment: null }), null);
});
reset();
let todayData = { localDate: session.localDate, scheduleVersion: 3, sessions: [session], reward };
const monthData = { today: session.localDate, days: [todayData], month: '2026-11', minMonth: '2026-11' };
const page = load('pages/MomentsPage.tsx', {
  '../features/moments/MomentViews': views,
  '../features/moments/api': { MOMENT_TODAY_KEY: ['today'], momentMonthKey: () => ['month'], momentsApi: {} },
  '../features/questions/useCouplePeople': { useCouplePeople: () => ({ partnerName: 'P', today: session.localDate }) },
  'react-router-dom': { useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(), () => {}] },
  '@tanstack/react-query': { useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'today' ? todayData : monthData }) },
}, ['DayPanel']);
test('Moments parent retains original keyed day through refetch rollover and releases it after resolution', () => {
  const before = render(page.MomentsPage);
  const panel = find(before, n => n.type === page.DayPanel);
  panel.props.onPendingChange(true);
  todayData = { ...todayData, localDate: '2026-11-19', sessions: [] };
  let after = render(page.MomentsPage);
  const old = find(after, n => n.type === page.DayPanel && n.props.day.localDate === session.localDate);
  const next = find(after, n => n.type === page.DayPanel && n.props.day.localDate === todayData.localDate);
  assert.ok(old); assert.equal(old.props.day.sessions[0].sessionId, session.sessionId);
  assert.equal(next.props.captureEnabled, false);
  const oldContainer = find(after, n => n.key === session.localDate);
  assert.equal(oldContainer.key, find(before, n => n.key === session.localDate).key);
  old.props.onPendingChange(false);
  after = render(page.MomentsPage);
  assert.equal(find(after, n => n.type === page.DayPanel && n.props.day.localDate === session.localDate), undefined);
  assert.equal(find(after, n => n.type === page.DayPanel).props.captureEnabled, true);
});
reset(); todayData = { localDate: session.localDate, scheduleVersion: 3, sessions: [session], reward };
test('Moments parent drops retained prior-day data on PIN discard', () => {
  find(render(page.MomentsPage), n => n.type === page.DayPanel).props.onPendingChange(true);
  todayData = { ...todayData, localDate: '2026-11-19', sessions: [] };
  discard = true; listener();
  assert.equal(find(render(page.MomentsPage), n => n.type === page.DayPanel && n.props.day.localDate === session.localDate), undefined);
});
const api = load('features/quests/api.ts');
test('invalidation includes ledger and wallet without awaiting hanging reads', () => {
  const keys = [];
  assert.equal(api.refreshQuestRewards({ invalidateQueries({ queryKey }) { keys.push(queryKey.join('/')); return new Promise(() => {}); } }), undefined);
  assert.deepEqual(keys, ['checkin', 'quests/today', 'wallet', 'ledger']);
});
console.log(`${count} reward UI / retention pure mock checks passed.`);
