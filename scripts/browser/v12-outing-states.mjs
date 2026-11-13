// Synthetic GET detail rendering only; never submit a mutation against fixture IDs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const at = '2026-11-13T02:00:00.000Z';
const id = n => n.toString(16).padStart(24, '0');
export const stateNames = ['invited', 'declined', 'collecting-empty', 'review-one-left', 'settling-pending-recipient', 'completed', 'restricted', 'ordinary-closed', 'tail-slots'];

export function makeStates(owner, partner) {
  assert(owner.id !== partner.id && [owner.id, partner.id].every(x => /^[a-f0-9]{24}$/.test(x)));
  const common = { id: id(900001), title: 'Buổi kiểm tra trạng thái', outingDate: '2026-11-13', creatorId: owner.id, myMembership: 'accepted', revision: 10, financeRevision: 2, phase: 'collecting', createdAt: at };
  const participants = [owner, partner].map(u => ({ userId: u.id, displayName: u.displayName, status: 'accepted', consent: null }));
  const expense = { id: id(900002), payerId: owner.id, title: 'Chi phí mẫu', amount: 200, splitMode: 'equal', participantIds: [owner.id, partner.id], allocations: [owner.id, partner.id].sort().map(userId => ({ userId, amount: 100 })), status: 'active', createdAt: at, updatedAt: at };
  const capacity = { participants: { used: 2, max: 50 }, expenses: { used: 1, max: 200 }, settlements: { used: 0, max: 500 }, edits: { used: 0, max: 1000 }, ordinaryOperations: { used: 4, max: 3000 }, reservedOperations: { used: 0, max: 1052 }, editsFrozen: false, finalSettlementSlots: false };
  const balance = (userId, paid, share, sent = 0, received = 0, reservedOutgoing = 0, reservedIncoming = 0) => ({ userId, paid, share, sent, received, balance: paid - share + sent - received, reservedOutgoing, reservedIncoming });
  const rows = [balance(owner.id, 200, 100), balance(partner.id, 0, 100)].sort((a, b) => a.userId.localeCompare(b.userId));
  const ledger = { ...common, access: 'full', participants, expenses: [expense], settlements: [], balances: rows, suggestions: [{ fromUserId: partner.id, toUserId: owner.id, amount: 100 }], totalExpenses: 200, eventId: null, capacity };
  const clone = () => structuredClone(ledger);
  const invitation = access => ({ ...common, creatorId: partner.id, access, myMembership: access === 'invited' ? 'pending' : 'declined' });
  const empty = clone(); empty.expenses = []; empty.totalExpenses = 0; empty.capacity.expenses.used = 0; empty.balances = rows.map(r => balance(r.userId, 0, 0)); empty.suggestions = [];
  const review = clone(); review.phase = 'review'; review.participants[1].consent = { status: 'approved', financeRevision: 2 };
  const settlement = (n, status, amount = 100) => ({ id: id(901000 + n), fromUserId: partner.id, toUserId: owner.id, amount, status, createdAt: at, resolvedAt: status === 'pending' ? null : at });
  const pending = clone(); pending.phase = 'settling'; pending.participants.forEach(p => { p.consent = { status: 'approved', financeRevision: 2 }; }); pending.settlements = [settlement(0, 'pending', 40)]; pending.capacity.settlements.used = 1; pending.capacity.reservedOperations.used = 1; pending.balances = rows.map(r => ({ ...r, reservedOutgoing: r.userId === partner.id ? 40 : 0, reservedIncoming: r.userId === owner.id ? 40 : 0 })); pending.suggestions[0].amount = 60;
  const completed = clone(); completed.phase = 'completed'; completed.participants = structuredClone(pending.participants); completed.settlements = [settlement(1, 'confirmed')]; completed.capacity.settlements.used = 1; completed.capacity.reservedOperations.used = 3; completed.balances = [balance(owner.id, 200, 100, 0, 100), balance(partner.id, 0, 100, 100, 0)].sort((a, b) => a.userId.localeCompare(b.userId)); completed.suggestions = [];
  const restricted = structuredClone(pending); restricted.access = 'restricted'; restricted.title = 'Buổi chia tiền'; restricted.expenses[0].title = null;
  const closed = structuredClone(review); closed.capacity.ordinaryOperations.used = 3000; closed.capacity.editsFrozen = true; closed.revision = 3000;
  const tail = clone(); tail.phase = 'settling'; tail.participants = structuredClone(pending.participants); tail.settlements = Array.from({ length: 451 }, (_, i) => settlement(i + 10, 'rejected')); tail.capacity.settlements.used = 451; tail.capacity.reservedOperations.used = 902; tail.capacity.ordinaryOperations.used = 3000; tail.capacity.editsFrozen = true; tail.capacity.finalSettlementSlots = true; tail.revision = 3902;
  const result = { invited: invitation('invited'), declined: invitation('declined'), 'collecting-empty': empty, 'review-one-left': review, 'settling-pending-recipient': pending, completed, restricted, 'ordinary-closed': closed, 'tail-slots': tail };
  stateNames.forEach((name, i) => { result[name].id = id(900100 + i); });
  return result;
}

export function validateStates(states, owner, partner) {
  assert.deepEqual(Object.keys(states), stateNames);
  assert.equal(new Set(Object.values(states).map(s => s.id)).size, stateNames.length);
  for (const [name, s] of Object.entries(states)) {
    if (s.access === 'invited' || s.access === 'declined') { assert(!('expenses' in s)); assert.notEqual(s.creatorId, owner.id, 'Creator cannot be a pending/declined invitee'); assert.equal(s.myMembership, s.access === 'invited' ? 'pending' : 'declined'); continue; }
    assert.equal(s.capacity.participants.used, s.participants.length); assert.equal(s.capacity.expenses.used, s.expenses.length); assert.equal(s.capacity.settlements.used, s.settlements.length);
    for (const v of Object.values(s.capacity).filter(v => typeof v === 'object')) assert(v.used >= 0 && v.used <= v.max);
    assert.equal(s.capacity.editsFrozen, s.capacity.ordinaryOperations.used >= 3000);
    assert.equal(s.capacity.finalSettlementSlots, s.settlements.length >= 451);
    assert.equal(s.totalExpenses, s.expenses.filter(e => e.status === 'active').reduce((n, e) => n + e.amount, 0));
    for (const e of s.expenses) { assert(Number.isSafeInteger(e.amount) && e.amount > 0 && e.amount <= 100000000); assert.equal(e.allocations.reduce((n, a) => n + a.amount, 0), e.amount); }
    for (const b of s.balances) {
      assert.equal(b.paid, s.expenses.filter(e => e.status === 'active' && e.payerId === b.userId).reduce((n, e) => n + e.amount, 0));
      assert.equal(b.share, s.expenses.filter(e => e.status === 'active').flatMap(e => e.allocations).filter(a => a.userId === b.userId).reduce((n, a) => n + a.amount, 0));
      for (const [field, status, key] of [['sent', 'confirmed', 'fromUserId'], ['received', 'confirmed', 'toUserId'], ['reservedOutgoing', 'pending', 'fromUserId'], ['reservedIncoming', 'pending', 'toUserId']]) assert.equal(b[field], s.settlements.filter(t => t.status === status && t[key] === b.userId).reduce((n, t) => n + t.amount, 0));
      assert.equal(b.balance, b.paid - b.share + b.sent - b.received);
    }
    assert.equal(s.balances.reduce((n, b) => n + b.balance, 0), 0, name);
    if (s.access === 'restricted') { assert.equal(s.title, 'Buổi chia tiền'); assert.equal(s.eventId, null); assert(s.expenses.every(e => e.title === null)); }
  }
  const p = states['settling-pending-recipient']; assert.equal(p.settlements[0].amount, 40); assert.equal(p.balances.find(b => b.userId === owner.id).balance, 100); assert.equal(p.balances.find(b => b.userId === partner.id).balance, -100);
  assert.equal(states['review-one-left'].participants.filter(p => p.consent?.status === 'approved').length, 1);
  assert(states.completed.balances.every(b => b.balance === 0));
}

async function main() {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-outing-states-${Date.now()}`);
  const h = await import('./harness.mjs');
  const inventory = [], checks = [], errors = []; let browser;
  const limitations = ['Synthetic GET detail rendering only; no server ACL, mutation, capacity or login-flow proof', 'No synthetic social detail requests; no settlement confirmation submitted', 'Screenshots require manual review; no visual acceptance implied', 'Loading/error, 390px, short viewport, zoom, reduced motion, keyboard and real device remain separate gates'];
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(fixture.synthetic && fixture.users?.length === 2, 'Existing synthetic friends-member baseline required');
    const [owner, partner] = fixture.users;
    const login = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
    const me = await h.api('GET', '/me', undefined, login.accessToken);
    assert.equal(me.user.id, owner.id, 'Baseline identity mismatch');
    // This real-user endpoint is guarded by requireFriendsMember; it never uses a synthetic outing ID.
    const membership = await fetch(`${h.apiURL}/api/friends/unread`, { headers: { Authorization: `Bearer ${login.accessToken}` }, signal: AbortSignal.timeout(20_000) });
    assert(membership.ok, `Existing friends membership required (HTTP ${membership.status})`);
    const states = makeStates(owner, partner); validateStates(states, owner, partner);
    browser = await h.openBrowser();
    for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
      for (const [name, view] of Object.entries(states)) {
        const { context, page } = await h.fresh(browser, `${name}-${viewport.width}`, errors);
        try {
          await page.setViewportSize(viewport);
          await context.addInitScript(({ login }) => { localStorage.setItem('lw.accessToken', login.accessToken); localStorage.setItem('lw.refreshToken', login.refreshToken); localStorage.setItem('lw.space', 'friends'); }, { login });
          let detailGets = 0;
          const syntheticIds = new Set(Object.values(states).flatMap(s => [s.id, ...(s.expenses ?? []).map(e => e.id), ...(s.settlements ?? []).map(t => t.id)]));
          await context.route('**/api/friends/**', async route => {
            const req = route.request(), pathname = new URL(req.url()).pathname;
            const synthetic = pathname.split('/').some(segment => syntheticIds.has(segment)) || [...new URL(req.url()).searchParams.values()].some(value => syntheticIds.has(value));
            if (!synthetic) return route.continue();
            if (req.method() === 'GET' && pathname === `/api/friends/outings/${view.id}`) { detailGets++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: view }) }); }
            errors.push({ type: 'blocked-synthetic-request', method: req.method(), path: '/api/friends/outings/:synthetic' }); return route.abort();
          });
          await page.goto(`${h.baseURL}/friends/outings/${view.id}`);
          const button = (label, root = page) => root.getByRole('button', { name: label, exact: true });
          await page.getByRole('heading', { name: view.title, exact: true }).waitFor();
          assert(detailGets > 0, 'Synthetic detail must be requested');
          const absent = async label => assert.equal(await button(label).count(), 0, `${name}: ${label} absent`);
          if (name === 'invited' || name === 'declined') {
            assert.equal(await page.locator('.outing-hero, .outing-expense').count(), 0);
            if (name === 'invited') { assert(await button('Nhận lời tham gia').isEnabled()); assert(await button('Từ chối').isEnabled()); }
            else { await absent('Nhận lời tham gia'); await absent('Từ chối'); }
          } else {
            if (name === 'collecting-empty') { await page.getByText('Chưa có khoản chi nào', { exact: true }).waitFor(); assert(await button('Thêm chi phí').isEnabled()); }
            if (name === 'review-one-left') { await page.getByText('1/2 người đã đồng ý', { exact: true }).waitFor(); assert(await button('Kiểm tra xong, đồng ý chốt').isEnabled()); }
            if (name === 'ordinary-closed') { assert(await button('Thêm chi phí').isDisabled()); assert(await button('Chưa đồng ý').isDisabled()); assert(await button('Kiểm tra xong, đồng ý chốt').isEnabled()); }
            if (name === 'completed') { await page.getByText('Đã đối chiếu xong. Hẹn nhau ở buổi vui tiếp theo.', { exact: true }).waitFor(); await absent('Thêm chi phí'); await absent('Hoàn tất buổi'); }
            if (name === 'restricted') { await page.getByText('Lịch sử tài chính hạn chế', { exact: true }).waitFor(); await absent('Thêm chi phí'); assert.equal(await page.getByText('Chi phí mẫu', { exact: true }).count(), 0); assert.equal(await page.getByRole('link', { name: /Xem kèo của buổi này/ }).count(), 0); }
            if (name === 'tail-slots') { await page.getByText(/49 chỗ cuối chỉ dùng/).waitFor(); await absent('Thêm chi phí'); }
            if (name === 'settling-pending-recipient' || name === 'restricted') { await page.getByText(/Chưa tính vào số dư/).waitFor(); assert.match(await page.locator('.outing-hero__balance').innerText(), /100/); await absent('Hoàn tất buổi'); }
          }
          await page.evaluate(() => document.fonts.ready); await h.noOverflow(page);
          const shot = async suffix => { const file = `N02-${name}-${suffix}-${viewport.width}`; await h.screenshot(page, file, { fullPage: false }); inventory.push({ state: name, viewport, screenshot: `${file}.png`, review: 'pending manual review', fixture: 'synthetic GET detail only', na: name === 'invited' || name === 'declined' ? 'ledger and settlement controls not applicable to invitation-only DTO' : name === 'completed' ? 'payment confirmation not applicable after completion' : 'other phases and loading/error not represented by this state' }); };
          await shot('main');
          if (name === 'settling-pending-recipient') {
            await button('Thanh toán').click();
            await page.getByText('Đã báo chuyển · Chờ xác nhận', { exact: true }).waitFor();
            assert(await button('Xác nhận đã nhận').isEnabled()); await absent('Hủy lời báo chuyển');
            await h.noOverflow(page); await shot('pending');
            await button('Xác nhận đã nhận').click();
            const dialog = page.getByRole('dialog', { name: 'Bạn đã thực sự nhận được tiền?', exact: true });
            await dialog.getByText(/chưa thể đảo ngược/).waitFor(); assert(await button('Tôi đã nhận đủ khoản này', dialog).isEnabled());
            await h.noOverflow(page); await shot('confirm-warning-unsubmitted');
          }
          checks.push(`${name} ${viewport.width}: expected display and permission assertions`);
        } finally { await context.close(); }
      }
    }
    assert.deepEqual(errors, []);
    await h.writeResult({ ok: true, auth: 'ordinary API login in memory for visual context only; not login-flow proof; requires existing friends member', checks, inventory, errors, limitations });
    console.log(`Display assertions completed; manual visual review pending: ${h.evidenceDir}`);
  } catch (error) {
    const failure = h.sanitize(String(error?.message || 'Failure').split('\nCall log:')[0]);
    await h.writeResult({ ok: false, checks, inventory, errors, failure, limitations }); console.error(failure); process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
