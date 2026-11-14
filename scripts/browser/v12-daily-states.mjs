// Synthetic display fixtures and explicitly intercepted mutation faults; never product writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const fixedTime = '2026-11-13T02:00:00.000Z';
export const viewports = [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }];
const id = n => n.toString(16).padStart(24, '0');
export const packs = {
  quests: { route: '/quests', target: '/api/quests/today', title: 'Nhiệm vụ', cases: ['populated', 'empty', 'failure', 'disabled', 'checkin', 'claim'] },
  water: { route: '/quests/water', target: '/api/water/today', title: 'Uống nước', cases: ['populated', 'empty', 'failure', 'pending-goal', 'manual', 'goal', 'photo'] },
  approvals: { route: '/approvals', target: '/api/water/pending', title: 'Cần duyệt', cases: ['populated', 'empty', 'failure', 'review', 'decline'] },
  moods: { route: '/profile/moods', target: '/api/moods', title: 'Cảm xúc 30 ngày', cases: ['populated', 'empty', 'failure'] },
};
export function classify(errors, faults) {
  const remaining = new Map();
  for (const f of faults) for (const type of ['http', 'console']) {
    assert(Number.isInteger(f.count) && f.count > 0);
    const key = `${f.label}|${type}|${f.path}|${f.status}`;
    assert(!remaining.has(key), 'Duplicate fault declaration'); remaining.set(key, f.count);
  }
  const unexpected = [];
  for (const e of errors) {
    const match = e.type === 'console' && /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(e.message);
    const status = e.type === 'http' ? e.status : match ? Number(match[1]) : 0;
    const key = `${e.label}|${e.type}|${e.path}|${status}`;
    if ((e.type === 'http' || match) && remaining.get(key) > 0) remaining.set(key, remaining.get(key) - 1);
    else unexpected.push(e);
  }
  assert.deepEqual(unexpected, [], 'Unexpected browser errors');
  assert.deepEqual([...remaining].filter(([, count]) => count), [], 'Missing expected faults');
}
export function fixtures(owner, partner) {
  assert(owner.id && partner.id && owner.id !== partner.id);
  const localDate = '2026-11-13';
  const log = (n, userId, status, amountMl, reviewedBy = null) => ({ id: id(n), userId, status, amountMl, reviewedBy, source: 'manual', hasImage: false, localDate, createdAt: fixedTime });
  const logs = [log(100, owner.id, 'approved', 750, partner.id), log(101, owner.id, 'pending', 350), log(102, owner.id, 'rejected', 150, partner.id), log(103, owner.id, 'rejected', 250, owner.id)];
  const quest = (key, type, status, title) => ({ key, type, status, title, description: 'Một việc nhỏ cùng nhau mỗi ngày, kể cả khi lịch trình thật bận rộn.', coinReward: 20, expReward: 15, progress: status === 'in_progress' ? 0 : 1, target: 1, localDate });
  const quests = [quest('water_goal', 'water_goal', 'in_progress', 'Uống đủ nước'), quest('daily_question', 'daily_question', 'in_progress', 'Cùng trả lời một câu hỏi thật dài về những kỷ niệm và dự định của chúng mình'), quest('checkin', 'checkin', 'rewarded', 'Điểm danh cùng nhau'), quest('custom_daily', 'custom_boolean', 'completed', 'Phần thưởng đã hoàn thành chờ nhận')];
  const proposals = [false, true].map((outgoing, i) => ({ id: id(200 + i), kind: outgoing ? 'anniversary_date' : 'water_goal', payload: outgoing ? { date: '2020-01-01' } : { goalMl: 2500 }, status: 'pending', createdBy: outgoing ? owner.id : partner.id, approvals: [outgoing ? owner.id : partner.id], createdAt: fixedTime, resolvedAt: null }));
  const market = [false, true].map((isBuyer, i) => ({ id: id(300 + i), itemId: id(310 + i), itemTitle: `Phần thưởng synthetic ${i + 1} với lời hứa cùng nhau đi thật xa và lưu giữ những ngày bình yên`, itemEmoji: '🎁', priceCoin: 1000000, buyerUserId: isBuyer ? owner.id : partner.id, sellerUserId: isBuyer ? partner.id : owner.id, buyerName: isBuyer ? owner.displayName : partner.displayName, sellerName: isBuyer ? partner.displayName : owner.displayName, isBuyer, status: 'requested', responseNote: null, createdAt: fixedTime, respondedAt: null, fulfilledAt: null }));
  const pending = [{ ...log(110, partner.id, 'pending', 500), submitterName: partner.displayName }, { ...logs[1], submitterName: owner.displayName }];
  const history = { from: '2026-10-15', to: localDate, items: Array.from({ length: 30 }, (_, i) => [owner, partner].map((u, j) => ({ userId: u.id, localDate: new Date(Date.parse('2026-10-15T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), mood: ['happy', 'loved', 'tired'][i % 3], note: i % 10 === 0 ? `Ghi chú synthetic ${i}-${j}: hôm nay cùng nhau đi qua một ngày bận rộn và dành thời gian lắng nghe. `.repeat(1) : '', updatedAt: fixedTime }))).flat() };
  return { quests, logs, proposals, market, pending, history, checkin: { localDate, checkedInToday: false, streak: 123, partnerCheckedIn: true }, water: { localDate, totalMl: 750, pendingMl: 350, goalMl: 2000, goalMet: false, remainingMl: 1250, logs, pendingGoalProposal: false }, emptyWater: { localDate, totalMl: 0, pendingMl: 0, goalMl: null, goalMet: false, remainingMl: null, logs: [], pendingGoalProposal: false } };
}
export function validate(f = fixtures({ id: id(1), displayName: 'An' }, { id: id(2), displayName: 'Bình' })) {
  assert.deepEqual(viewports.map(v => v.width), [360, 390, 1280]);
  assert.deepEqual(f.quests.map(q => q.status), ['in_progress', 'in_progress', 'rewarded', 'completed']);
  assert(f.quests.every(q => q.target > 0 && q.progress <= q.target));
  assert.equal(new Set(f.quests.map(q => q.key)).size, f.quests.length);
  assert.equal(f.water.totalMl, f.logs.filter(l => l.status === 'approved').reduce((n, l) => n + l.amountMl, 0));
  assert.equal(f.water.pendingMl, f.logs.filter(l => l.status === 'pending').reduce((n, l) => n + l.amountMl, 0));
  assert.equal(f.water.remainingMl, f.water.goalMl - f.water.totalMl);
  assert.deepEqual(f.logs.map(l => l.status), ['approved', 'pending', 'rejected', 'rejected']);
  assert.equal(new Set(f.logs.map(l => l.id)).size, 4);
  assert.equal(f.emptyWater.logs.length, 0); assert.equal(f.emptyWater.goalMl, null);
  assert.equal(f.history.items.length, 60); assert.equal(new Set(f.history.items.map(x => `${x.userId}-${x.localDate}`)).size, 60);
  assert.equal(f.history.items[0].localDate, f.history.from); assert.equal(f.history.items.at(-1).localDate, f.history.to);
  assert.deepEqual(f.market.map(r => r.isBuyer), [false, true]); assert(f.market.every(r => r.status === 'requested'));
  assert.equal(f.pending.length, 2); assert.notEqual(f.pending[0].userId, f.pending[1].userId);
  assert(f.proposals.every(p => p.status === 'pending' && p.approvals.length === 1));
  return true;
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 12000); })]); }
  finally { clearTimeout(timer); }
}
// Hit-test after scrolling: a visible box alone can still sit beneath fixed navigation.
async function reachable(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  // Center rather than nearest: after resizing, a geometrically visible control may sit under the sticky header.
  await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  const hit = await locator.evaluate(el => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return { reachable: r.width > 0 && r.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && el.contains(top), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, occluder: top?.className }; });
  assert(hit.reachable, `Control is obscured or unreachable: ${JSON.stringify(hit)}`);
}
async function visibleFailure(page) {
  const message = page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Lỗi synthetic daily, dữ liệu chưa thay đổi' });
  await message.waitFor();
  assert(await message.evaluate(el => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !el.closest('[inert]') && el.contains(hit);
  }), 'Mutation error feedback must be visible and non-inert while the modal stays open');
}
async function modalKeyboard(page, dialog) {
  await dialog.waitFor();
  for (const key of ['Tab', 'Shift+Tab', 'Tab']) { await page.keyboard.press(key); assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'Focus escaped modal'); }
}
async function main() {
  validate();
  if (process.argv.includes('--validate')) { console.log('PASS daily deterministic fixtures/manifest; browser not imported'); return; }
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-daily-states-${Date.now()}`);
  const h = await import('./harness.mjs');
  let browser, stage = 'startup';
  const checks = [], inventory = [], errors = [], faults = [], blocked = [];
  const limitations = ['Synthetic display and intercepted 503 mutations only; no persistence, ACL or provider proof', 'Quests has no dedicated empty-list message; empty means no generic quest cards and unset water goal', 'Mood history is read-only: disabled/pending mutation and modal states are not applicable', 'Screenshots require manual visual review; normal/short viewport modal checks are not 200% zoom proof'];
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const baseline = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(baseline.synthetic === true && baseline.users?.length === 2, 'Private synthetic paired baseline required');
    const [owner, partner] = baseline.users;
    const f = fixtures(owner, partner); validate(f);
    const tokens = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
    const me = await h.api('GET', '/me', undefined, tokens.accessToken);
    assert.equal(me.user.id, owner.id); assert(me.user.coupleId && me.couple, 'Paired baseline required');
    assert(me.couple.members.some(m => m.id === partner.id), 'Baseline partner mismatch');
    browser = await h.openBrowser();
    for (const viewport of viewports) for (const [family, pack] of Object.entries(packs)) for (const scenario of pack.cases) {
      const label = `${family}-${scenario}-${viewport.width}`; stage = label;
      const { context, page } = await h.fresh(browser, label, errors, { reducedMotion: 'reduce' });
      const loadGate = gate(), mutationGate = gate(), mutationArrival = gate();
      let mode = scenario === 'failure' ? 'held' : 'normal', failures = 0, successes = 0, mutations = 0;
      const mutationPath = family === 'quests' ? (scenario === 'checkin' ? '/api/checkin' : scenario === 'claim' ? '/api/quests/custom_daily/claim' : null)
        : family === 'water' ? (scenario === 'manual' ? '/api/water/manual' : scenario === 'goal' ? '/api/water/goal/propose' : scenario === 'photo' ? '/api/water/upload-url' : null)
          : family === 'approvals' ? (scenario === 'review' ? `/api/water/logs/${f.pending[0].id}/approve` : scenario === 'decline' ? `/api/market/redemptions/${f.market[0].id}/decline` : null) : null;
      const empty = scenario === 'empty';
      const send = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
      const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'V12_DAILY_FAULT', message: 'Lỗi synthetic daily, dữ liệu chưa thay đổi' } }) });
      try {
        await page.setViewportSize(viewport); await page.clock.setFixedTime(new Date(fixedTime));
        await context.addInitScript(tokens => { localStorage.setItem('lw.accessToken', tokens.accessToken); localStorage.setItem('lw.refreshToken', tokens.refreshToken); localStorage.setItem('lw.space', 'couple'); }, tokens);
        await context.route('**/api/**', async route => {
          const req = route.request(), url = new URL(req.url()), p = url.pathname;
          if (req.method() !== 'GET') {
            if (req.method() === 'POST' && mutationPath && p === mutationPath) { mutations++; mutationArrival.release(); await mutationGate.promise; return fail(route); }
            blocked.push({ label, method: req.method(), path: p }); return route.abort();
          }
          if (p === pack.target && scenario === 'failure') {
            if (mode === 'held') await loadGate.promise;
            if (mode === 'failure') { failures++; return fail(route); }
            successes++;
          }
          if (p === '/api/me') return send(route, me);
          if (p === '/api/quests/today') return send(route, empty ? [] : f.quests);
          if (p === '/api/checkin') return send(route, { ...f.checkin, checkedInToday: scenario === 'disabled' });
          if (p === '/api/water/today') return send(route, empty || scenario === 'pending-goal' ? { ...f.emptyWater, pendingGoalProposal: scenario === 'pending-goal' } : f.water);
          if (p === '/api/water/pending') return send(route, empty ? [] : f.pending);
          if (p === '/api/proposals' && url.searchParams.get('status') === 'pending') return send(route, empty ? [] : f.proposals);
          if (p === '/api/market/redemptions/pending') return send(route, empty ? [] : f.market);
          if (p === '/api/market/unread-count') return send(route, { count: 0, responded: 0, newItems: 0 });
          if (p === '/api/wallet') return send(route, { coinBalance: 1000000, level: 12, exp: 1250, levelBaseExp: 1200, nextLevelExp: 1400 });
          if (p === '/api/bucket') return send(route, { items: [], counts: { todo: 0, done: 0 } });
          if (p === '/api/moods' && url.searchParams.get('days') === '30') return send(route, { ...f.history, items: empty ? [] : f.history.items });
          return route.continue();
        });
        const shot = async state => { await page.evaluate(() => document.fonts.ready); await h.noOverflow(page); const name = `${label}-${state}`; await h.screenshot(page, name, { fullPage: false }); inventory.push({ route: pack.route, family, scenario, state, viewport: await page.viewportSize(), screenshot: `${name}.png`, review: 'pending manual review' }); };
        await page.goto(h.baseURL + pack.route);
        await page.getByRole('heading', { name: pack.title, exact: true, level: 1 }).waitFor();
        if (scenario === 'failure') {
          await page.locator('.page [aria-busy="true"]').first().waitFor(); await shot('loading');
          mode = 'failure'; loadGate.release();
          const alert = page.getByRole('alert').filter({ hasText: 'Không tải được dữ liệu' }); await alert.waitFor();
          assert.equal(failures, 2, 'Initial GET plus one query retry'); await shot('error');
          mode = 'normal'; await alert.getByRole('button', { name: 'Thử lại', exact: true }).click(); await alert.waitFor({ state: 'hidden' });
          assert.equal(successes, 1, 'Exactly one manual recovery request'); faults.push({ label, path: pack.target, status: 503, count: 2 });
        }
        if (family === 'quests') {
          await page.getByRole('heading', { name: 'Uống đủ nước', exact: true }).waitFor();
          if (empty) { assert.equal(await page.locator('article.quest-card').count(), 1); await page.getByRole('button', { name: 'Đề xuất mục tiêu', exact: true }).waitFor(); }
          else { await page.getByText(f.quests[1].title, { exact: true }).waitFor(); assert.equal(await page.locator('article.quest-card').count(), 4); await page.getByText('Đã nhận', { exact: true }).waitFor(); }
          if (scenario === 'disabled') assert(await page.getByRole('button', { name: 'Đã điểm danh hôm nay', exact: true }).isDisabled());
          await shot(scenario === 'failure' ? 'retry' : scenario);
          if (mutationPath) {
            const trigger = page.getByRole('button', { name: scenario === 'checkin' ? 'Điểm danh hôm nay' : 'Nhận', exact: true });
            await reachable(page, trigger); await trigger.click(); await bounded(mutationArrival.promise, label);
            const busy = scenario === 'checkin' ? page.getByRole('button', { name: 'Đang điểm danh…', exact: true }) : trigger;
            await busy.and(page.locator(':disabled')).waitFor(); assert(await busy.isDisabled()); assert.equal(mutations, 1); await shot('pending-disabled'); mutationGate.release();
            await page.getByText('Lỗi synthetic daily, dữ liệu chưa thay đổi', { exact: true }).waitFor(); assert(await trigger.isEnabled()); await shot('mutation-error');
            // Dismiss the observed transient toast before independently testing bottom navigation.
            await page.getByRole('button', { name: 'Đóng thông báo', exact: true }).click();
          }
          const bottom = page.getByRole('link', { name: 'Mở bucket list', exact: true }); await reachable(page, bottom); assert.equal(await bottom.getAttribute('href'), '/quests/bucket'); await shot('bottom-reachable');
        } else if (family === 'water') {
          await page.getByRole('heading', { name: 'Hôm nay của bạn', exact: true }).waitFor();
          if (empty || scenario === 'pending-goal') await page.getByText('Chưa có lượt nào', { exact: true }).waitFor();
          else for (const status of ['Đã xác nhận', 'Chờ duyệt', 'Bị từ chối', 'Đã rút lại']) await page.getByText(status, { exact: true }).waitFor();
          await shot(scenario === 'failure' ? 'retry' : scenario);
          const goal = page.getByRole(scenario === 'pending-goal' ? 'link' : 'button', { name: /Mục tiêu mỗi ngày/ });
          await reachable(page, goal);
          if (scenario === 'pending-goal') { assert.equal(await goal.getAttribute('href'), '/approvals'); assert.equal(await page.getByRole('button', { name: /Mục tiêu mỗi ngày/ }).count(), 0); }
          await shot('bottom-reachable');
          if (scenario === 'photo') {
            const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
            await page.locator('input[type="file"]').setInputFiles({ name: 'synthetic-water.png', mimeType: 'image/png', buffer: image });
            const dialog = page.getByRole('dialog', { name: 'Ghi nhận nước bằng ảnh', exact: true }); await modalKeyboard(page, dialog);
            await bounded(mutationArrival.promise, label); await dialog.getByText('Đang tải ảnh lên…', { exact: true }).waitFor();
            assert(await page.getByRole('button', { name: 'Đang xử lý…', exact: true }).isDisabled()); assert.equal(mutations, 1); await shot('photo-upload-pending');
            mutationGate.release(); await dialog.getByRole('alert').waitFor(); await reachable(page, dialog.getByRole('button', { name: 'Chụp lại', exact: true })); await shot('photo-upload-error');
            await dialog.getByRole('button', { name: 'Nhập thủ công', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
            const manual = page.getByRole('dialog', { name: 'Nhập lượng nước', exact: true }); await manual.waitFor(); assert.equal(await manual.getByRole('spinbutton').inputValue(), '250'); await reachable(page, manual.locator('button[type="submit"]')); await shot('photo-manual-fallback');
            await page.keyboard.press('Escape'); await manual.waitFor({ state: 'hidden' });
          } else if (mutationPath) {
            const trigger = scenario === 'manual' ? page.getByRole('button', { name: 'Nhập thủ công', exact: true }) : goal;
            // Short-height coverage supplements each requested normal viewport.
            await page.setViewportSize({ width: viewport.width, height: 520 }); await reachable(page, trigger);
            const scrollBefore = await page.evaluate(() => ({ y: scrollY, overflow: document.body.style.overflow })); await trigger.click();
            const dialog = page.getByRole('dialog', { name: scenario === 'manual' ? 'Nhập lượng nước' : 'Mục tiêu nước mỗi ngày', exact: true }); await modalKeyboard(page, dialog);
            const input = dialog.getByRole('spinbutton'), submit = dialog.locator('button[type="submit"]');
            await input.fill('0'); assert(await submit.isDisabled()); await shot('invalid-disabled');
            await input.fill(scenario === 'manual' ? '350' : '2500'); assert(await submit.isEnabled()); await reachable(page, submit); await shot('modal-save-reachable');
            await submit.click(); await bounded(mutationArrival.promise, label); await submit.and(page.locator(':disabled')).waitFor(); assert(await submit.isDisabled()); assert.equal(mutations, 1); await shot('pending-disabled');
            // Reopening must not reset the mutation observer while its first request is held.
            await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
            assert(await trigger.evaluate(el => el === document.activeElement), 'Pending close restores trigger focus');
            await trigger.click(); await modalKeyboard(page, dialog);
            // Allow open effects and the subsequent React render to settle before testing disabled.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert(await submit.isDisabled(), 'Reopened sheet retains pending submission');
            assert.equal(mutations, 1, 'Reopening sends no duplicate request');
            // Existing forms reset their input on open. Restore the draft to exercise failure retention.
            await input.fill(scenario === 'manual' ? '350' : '2500');
            assert(await submit.isDisabled(), 'Editing the reopened draft cannot enable a pending submit');
            await submit.evaluate(el => el.click());
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(mutations, 1, 'Disabled submit click cannot duplicate the held mutation');
            await shot('pending-reopened-disabled'); mutationGate.release();
            await page.getByText('Lỗi synthetic daily, dữ liệu chưa thay đổi', { exact: true }).waitFor(); assert.equal(await input.inputValue(), scenario === 'manual' ? '350' : '2500'); assert(await submit.isEnabled()); await shot('error-draft-retained'); await visibleFailure(page);
            await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert(await trigger.evaluate(el => el === document.activeElement), 'Modal focus restored');
            assert.equal(await page.evaluate(() => document.body.style.overflow), scrollBefore.overflow, 'Body scroll lock restored');
            assert(Math.abs(await page.evaluate(() => scrollY) - scrollBefore.y) <= 2, 'Page scroll position restored');
            const toastClose = page.getByRole('button', { name: 'Đóng thông báo', exact: true });
            if (await toastClose.count()) await toastClose.click();
            await reachable(page, trigger);
          }
          assert.equal(await page.getByRole('link', { name: 'Quay lại', exact: true }).getAttribute('href'), '/quests');
        } else if (family === 'approvals') {
          if (empty) { await page.getByText('Không có gì cần bạn duyệt', { exact: true }).waitFor(); assert.equal(await page.locator('article.approval').count(), 0); }
          else { await page.getByText('Mục tiêu nước mới', { exact: true }).waitFor(); assert.equal(await page.locator('article.approval').count(), 6); await page.getByRole('button', { name: 'Nhận lời', exact: true }).waitFor(); }
          await shot(scenario === 'failure' ? 'retry' : scenario);
          if (!empty) { await reachable(page, page.locator('article.approval').last().getByRole('button')); await shot('outgoing-bottom-reachable'); }
          if (scenario === 'review') {
            const card = page.locator('article.approval').filter({ has: page.getByRole('button', { name: 'Xác nhận', exact: true }) });
            await card.getByRole('button', { name: 'Xác nhận', exact: true }).click(); await bounded(mutationArrival.promise, label);
            for (const name of ['Xác nhận', 'Từ chối']) { const button = card.getByRole('button', { name, exact: true }); await button.and(page.locator(':disabled')).waitFor(); assert(await button.isDisabled()); }
            assert.equal(mutations, 1); await shot('pending-disabled'); mutationGate.release();
            await page.getByText('Lỗi synthetic daily, dữ liệu chưa thay đổi', { exact: true }).waitFor(); assert(await card.getByRole('button', { name: 'Xác nhận', exact: true }).isEnabled()); await shot('review-error-retained');
          } else if (scenario === 'decline') {
            const card = page.locator('article.approval').filter({ has: page.getByRole('button', { name: 'Nhận lời', exact: true }) });
            const trigger = card.getByRole('button', { name: 'Từ chối', exact: true });
            await page.setViewportSize({ width: viewport.width, height: 520 }); await trigger.click();
            const dialog = page.getByRole('dialog', { name: 'Từ chối yêu cầu?', exact: true }); await modalKeyboard(page, dialog);
            const note = dialog.getByRole('textbox'); assert.equal(await note.getAttribute('maxlength'), '200'); await note.fill('Lời nhắn synthetic để kiểm tra nội dung vẫn được giữ khi yêu cầu thất bại.');
            const draft = await note.inputValue(), submit = dialog.getByRole('button', { name: 'Từ chối', exact: true }); await reachable(page, submit); await shot('modal-save-reachable');
            await submit.click(); await bounded(mutationArrival.promise, label); await submit.and(page.locator(':disabled')).waitFor(); assert(await submit.isDisabled()); assert.equal(mutations, 1); await shot('pending-disabled'); mutationGate.release();
            await page.getByText('Lỗi synthetic daily, dữ liệu chưa thay đổi', { exact: true }).waitFor(); assert.equal(await note.inputValue(), draft); assert(await submit.isEnabled()); await shot('error-draft-retained'); await visibleFailure(page);
            await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert(await trigger.evaluate(el => el === document.activeElement));
          }
          assert.equal(await page.getByRole('link', { name: 'Quay lại', exact: true }).getAttribute('href'), '/');
        } else {
          if (empty) { await page.getByText('Chưa có cảm xúc nào', { exact: true }).waitFor(); const home = page.getByRole('link', { name: 'Về Trang chủ', exact: true }); assert.equal(await home.getAttribute('href'), '/'); await reachable(page, home); }
          else { await page.getByRole('heading', { name: 'Chú thích', exact: true }).waitFor(); assert.equal(await page.locator('.mood-strip .mood-cell').count(), 60); assert.equal(await page.locator('.mood-cell--today').count(), 2); assert.equal(await page.locator('.mood-strip .mood-cell--empty').count(), 0); }
          await shot(scenario === 'failure' ? 'retry' : scenario);
          if (!empty) { const last = page.locator('.page .list__item').last(); await reachable(page, last); await shot('notes-bottom'); }
          assert.equal(await page.getByRole('link', { name: 'Quay lại', exact: true }).getAttribute('href'), '/profile');
        }
        if (mutationPath) { assert.equal(mutations, 1); faults.push({ label, path: mutationPath, status: 503, count: 1 }); }
        checks.push(`${label}: state, boundary and reachability assertions completed`);
      } finally { loadGate.release(); mutationGate.release(); await context.close(); }
    }
    classify(errors, faults); assert.deepEqual(blocked, [], 'Unexpected mutations blocked');
    await h.writeResult({ ok: true, checks, inventory, errors, faults, manifest: packs, limitations });
    console.log(`PASS ${checks.length} daily cases; ${inventory.length} captures; ${h.evidenceDir}`);
  } catch (error) {
    const failure = h.sanitize(String(error?.message || error).split('\nCall log:')[0]);
    await h.writeResult({ ok: false, stage, checks, inventory, errors, faults, blocked, failure, limitations }); console.error(failure); process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
