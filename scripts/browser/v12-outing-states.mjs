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

export function contrastOnWhite(color) {
  const match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(color);
  assert(match, `Unsupported computed text color: ${color}`);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const rgb = match.slice(1, 4).map(Number);
  assert(alpha >= 0 && alpha <= 1 && rgb.every(v => v >= 0 && v <= 255));
  const linear = rgb.map(v => (v * alpha + 255 * (1 - alpha)) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 1.05 / (linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 + 0.05);
}

export function assertReachableGeometry(m) {
  assert(m.enabled && m.focused, 'Control must be enabled and keyboard-focused');
  assert(m.width > 0 && m.height > 0, 'Control needs a nonempty box');
  assert(m.left >= m.safeLeft && m.right <= m.safeRight && m.top >= m.safeTop && m.bottom <= m.safeBottom, 'Entire control must fit inside visual viewport above fixed navigation/header');
  assert(m.hits.length === 5 && m.hits.every(Boolean), 'Control center and inset corners must not be covered by another element');
}

// Run only as a locator evaluation; this function deliberately has no module closures.
export function measureControl(element) {
  const r = element.getBoundingClientRect(), vv = window.visualViewport;
  const safeLeft = vv?.offsetLeft ?? 0, safeRight = safeLeft + (vv?.width ?? innerWidth);
  let safeTop = vv?.offsetTop ?? 0, safeBottom = safeTop + (vv?.height ?? innerHeight);
  if (!element.closest('[role="dialog"]')) {
    for (const overlay of document.querySelectorAll('.bottom-nav, .page-header')) {
      const style = getComputedStyle(overlay), box = overlay.getBoundingClientRect();
      if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden') continue;
      if (overlay.matches('.bottom-nav')) safeBottom = Math.min(safeBottom, box.top);
      else if (box.top <= safeTop) safeTop = Math.max(safeTop, box.bottom);
    }
  }
  // Rounded button corners are intentionally outside the painted hit shape.
  const dx = Math.min(12, r.width / 4), dy = Math.min(12, r.height / 4);
  const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + dx, r.top + dy], [r.right - dx, r.top + dy], [r.left + dx, r.bottom - dy], [r.right - dx, r.bottom - dy]];
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, safeLeft, safeRight, safeTop, safeBottom, enabled: !element.matches(':disabled, [aria-disabled="true"]'), focused: document.activeElement === element, hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit === element || element.contains(hit); }) };
}

async function main() {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-outing-states-${Date.now()}`);
  const h = await import('./harness.mjs');
  const inventory = [], checks = [], errors = []; let browser;
  const limitations = ['Synthetic GET detail rendering only; no server ACL, mutation, capacity or login-flow proof', 'No synthetic social detail requests; no settlement confirmation submitted', 'Screenshots are explicit viewport-only captures requiring manual review; no full-page or visual acceptance implied', 'Control focus and Tab return are checked; comprehensive keyboard/assistive technology acceptance is not proved', 'Loading/error, 390px, short viewport, zoom, reduced motion and real device remain separate gates'];
  const counts = () => ({ mainStates: inventory.filter(s => /-main-/.test(s.screenshot)).length, screenshots: inventory.length, checks: checks.length });
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
          await page.getByRole('heading', { name: view.title, level: 2, exact: true }).waitFor();
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
          const reach = async (control, label) => {
            assert.equal(await control.count(), 1, `${name}: unique ${label}`);
            assert(await control.isEnabled(), `${name}: enabled ${label}`);
            await control.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
            let geometry = await control.evaluate(measureControl);
            if (!(await control.evaluate(el => Boolean(el.closest('[role="dialog"]'))))) {
              await page.evaluate(({ delta }) => window.scrollBy({ top: delta, behavior: 'instant' }), { delta: (geometry.top + geometry.bottom - geometry.safeTop - geometry.safeBottom) / 2 });
            }
            await control.focus();
            // Traverse away and back without activation; no synthetic write can be sent.
            await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
            geometry = await control.evaluate(measureControl);
            assertReachableGeometry(geometry);
            await control.click({ trial: true });
            assertReachableGeometry(await control.evaluate(measureControl));
            checks.push(`${name} ${viewport.width}: ${label} scrolled fully visible, five-point hit-tested, Tab-return focused and trial-clickable`);
          };
          if (name === 'invited' || name === 'declined') {
            const style = await page.locator('.outing-invitation .outing-eyebrow').evaluate(el => {
              const s = getComputedStyle(el), card = getComputedStyle(el.closest('.outing-invitation'));
              return { color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight, opacity: s.opacity, background: card.backgroundColor };
            });
            assert.equal(style.background, 'rgb(255, 255, 255)', 'Invitation contrast assumes a white card'); assert.equal(Number(style.opacity), 1);
            const ratio = contrastOnWhite(style.color);
            assert(ratio >= 4.5, `${name}: eyebrow ${style.color}, ${style.fontSize}/${style.fontWeight} contrast ${ratio.toFixed(2)} on white must be >=4.5`);
            checks.push(`${name} ${viewport.width}: eyebrow ${style.fontSize}/${style.fontWeight}, contrast ${ratio.toFixed(2)} on white >=4.5`);
            if (name === 'invited') for (const label of ['Nhận lời tham gia', 'Từ chối']) await reach(button(label), label);
          }
          if (name === 'collecting-empty') for (const label of ['Thêm chi phí', 'Đề nghị chốt sổ']) await reach(button(label), label);
          if (name === 'review-one-left' || name === 'ordinary-closed') {
            if (name === 'review-one-left') await reach(button('Chưa đồng ý'), 'Chưa đồng ý');
            await reach(button('Kiểm tra xong, đồng ý chốt'), 'Kiểm tra xong, đồng ý chốt');
            await shot('review-approve-reachable');
          }
          if (name !== 'invited' && name !== 'declined') {
            const sections = page.getByRole('navigation', { name: 'Nội dung sổ chia tiền', exact: true });
            const history = button('Lịch sử', sections);
            await reach(history, 'Lịch sử tab (horizontal scroll)');
            await history.click();
            assert.equal(await history.getAttribute('aria-pressed'), 'true');
            await page.getByRole('heading', { name: 'Dấu mốc và khoản đã ghi', exact: true }).waitFor();
            await h.noOverflow(page); await shot('history-reachable');
            const payment = sections.getByRole('button', { name: /^Thanh toán/ });
            await reach(payment, 'Thanh toán tab'); await payment.click();
          }
          if (name === 'settling-pending-recipient' || name === 'restricted') {
            await page.getByText('Đã báo chuyển · Chờ xác nhận', { exact: true }).waitFor();
            assert.match(await page.locator('.outing-hero__balance').innerText(), /100/);
            await absent('Hủy lời báo chuyển');
            await h.noOverflow(page); await shot('pending');
            await reach(button('Chưa nhận · Từ chối'), 'Chưa nhận · Từ chối');
            await reach(button('Xác nhận đã nhận'), 'Xác nhận đã nhận');
            await shot('pending-buttons-reachable');
            await button('Xác nhận đã nhận').click();
            const dialog = page.getByRole('dialog', { name: 'Bạn đã thực sự nhận được tiền?', exact: true });
            await dialog.getByText(/chưa thể đảo ngược/).waitFor();
            await reach(button('Đóng', dialog), 'dialog Đóng');
            await reach(button('Quay lại kiểm tra', dialog), 'dialog Quay lại kiểm tra');
            await reach(button('Tôi đã nhận đủ khoản này', dialog), 'dialog Tôi đã nhận đủ khoản này (unsubmitted)');
            await h.noOverflow(page); await shot('confirm-warning-unsubmitted');
          }
          checks.push(`${name} ${viewport.width}: expected display and permission assertions`);
        } finally { await context.close(); }
      }
    }
    assert.deepEqual(errors, []);
    await h.writeResult({ ok: true, auth: 'ordinary API login in memory for visual context only; not login-flow proof; requires existing friends member', counts: counts(), checks, inventory, errors, limitations });
    console.log(`Display assertions completed; manual visual review pending: ${h.evidenceDir}`);
  } catch (error) {
    const failure = h.sanitize(String(error?.message || 'Failure').split('\nCall log:')[0]);
    await h.writeResult({ ok: false, counts: counts(), checks, inventory, errors, failure, limitations }); console.error(failure); process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
