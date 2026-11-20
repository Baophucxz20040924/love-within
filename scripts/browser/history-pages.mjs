// Fully intercepted UI fixtures; no API, DB, provider or credentials are used.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fixtures, fixedTime } from './daily-rewards-water.mjs';

const id = n => n.toString(16).padStart(24, '0');
function data() {
  const f = fixtures();
  const story = { id: id(500), author: f.users[0], isMine: true, body: 'Bài viết kiểm tra lịch sử', photos: [], videos: [], mood: null, happenedOn: '2026-11-18', createdAt: fixedTime, editedAt: null, reactions: { mine: null, partner: null }, commentCount: 40 };
  const comments = Array.from({ length: 40 }, (_, i) => ({ id: id(600 + i), author: f.users[0], isMine: true, body: `Bình luận synthetic ${String(40 - i).padStart(2, '0')}`, createdAt: fixedTime }));
  const ledger = Array.from({ length: 40 }, (_, i) => ({ ...f.ledger[i % f.ledger.length], id: id(800 + i) }));
  return { ...f, story, comments, ledger };
}
if (process.argv.includes('--validate')) {
  const f = data();
  assert.equal(new Set(f.comments.map(c => c.id)).size, 40);
  assert.equal(new Set(f.ledger.map(c => c.id)).size, 40);
  assert(f.ledger.every(e => e.provenance));
  console.log('PASS history fixtures; no browser/network imported');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_history_browser', `${Date.now()}`);
  const h = await import('./harness.mjs');
  const checks = [], errors = [], blocked = [], faults = [], inventory = [], requests = [];
  let browser, currentPage, stage = 'startup', closing = false;
  const json = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: value }) });
  async function until(fn, label) { const start = Date.now(); while (!await fn()) { assert(Date.now() - start < 12000, label); await new Promise(r => setTimeout(r, 40)); } }
  async function shot(page, name) { await h.noOverflow(page); await h.screenshot(page, name, { fullPage: false }); inventory.push(`${name}.png`); }
  try {
    browser = await h.openBrowser();
    for (const [label, viewport] of [['mobile', { width: 360, height: 780 }], ['desktop', { width: 1280, height: 800 }]]) {
      const f = data();
      const s = { ledger: 'normal', comments: 'normal', failAdd: true, added: false, deleted: false, ledgerReads: 0, commentReads: 0 };
      let releaseLedger;
      const heldLedger = new Promise(resolve => { releaseLedger = resolve; });
      const context = await browser.newContext({ viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', serviceWorkers: 'block', reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: 'synthetic-history', tokens: { accessToken: 'mock-history-access', refreshToken: 'mock-history-refresh' } }));
        localStorage.setItem('lw.space', 'couple');
      });
      await context.routeWebSocket('**/*', socket => socket.onMessage(() => {}));
      await context.route('**/*', async route => {
        try {
          const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
          if (url.origin !== h.baseURL) { blocked.push({ label, method, path: p }); return route.abort('blockedbyclient'); }
          if (!p.startsWith('/api/') && method === 'GET') return route.continue();
          requests.push({ label, method, path: p });
          const fault = status => {
            faults.push({ label, path: p, status });
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: status === 403 ? 'FORBIDDEN' : 'SYNTHETIC_FAULT', message: status === 403 ? 'Không còn quyền xem' : 'Lỗi thử nghiệm' } }) });
          };
          if (method === 'GET') {
            if (p === '/api/me') return json(route, { user: f.users[0], couple: f.couple, wallet: { ownerUserId: f.users[0].id, coinBalance: 100, exp: 125, level: 2, levelBaseExp: 100, nextLevelExp: 200 }, level: 2, exp: 125 });
            if (p === '/api/privacy-lock') return json(route, { couple: false, friends: false, revision: 1 });
            if (p === '/api/couple') return json(route, f.couple);
            if (p === '/api/wallet') return json(route, { ownerUserId: f.users[0].id, coinBalance: 100, exp: 125, level: 2, levelBaseExp: 100, nextLevelExp: 200 });
            if (p === '/api/water/today') return json(route, { localDate: '2026-11-18', totalMl: 0, pendingMl: 0, goalMl: 2000, goalMet: false, remainingMl: 2000, logs: [], pendingGoalProposal: false });
            if (p === '/api/finance/connection') return json(route, { linked: false, status: null, bankBrand: null, accountLast4: null, lastSuccessAt: null, lastError: null, visibility: 'private' });
            if (p === '/api/push/config') return json(route, { enabled: false, publicKey: null, vapidPublicKey: null });
            if (p === '/api/notifications/unread') return json(route, { notifications: 0, notificationsSaturated: false });
            if (p === '/api/stories/unread-count') return json(route, { count: 0, stories: 0, comments: 0 });
            if (p === '/api/market/unread-count') return json(route, { count: 0, responded: 0, newItems: 0 });
            if (p === '/api/realtime') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic\n\n' });
            if (p === '/api/ledger/page') {
              s.ledgerReads++; assert.equal(url.searchParams.get('limit'), '20');
              if (s.ledger === 'hold') await heldLedger;
              if (s.ledger === 'error') return fault(503);
              if (s.ledger === 'empty') return json(route, { items: [], nextCursor: null });
              const old = url.searchParams.has('cursor');
              return json(route, { items: f.ledger.slice(old ? 20 : 0, old ? 40 : 20), nextCursor: old ? null : 'synthetic-ledger-older' });
            }
            if (p === `/api/stories/${f.story.id}`) return json(route, f.story);
            if (p === `/api/stories/${f.story.id}/comments/page`) {
              s.commentReads++; assert.equal(url.searchParams.get('limit'), '20');
              if (s.comments === 'denied') return fault(403);
              if (s.comments === 'empty') return json(route, { items: [], nextCursor: null });
              const old = url.searchParams.has('cursor');
              const items = old ? (s.deleted ? [] : f.comments.slice(20)) : [...(s.added ? [{ ...f.comments[0], id: id(999), body: 'Nội dung giữ khi lỗi' }] : []), ...f.comments.slice(0, 20)].slice(0, 20);
              return json(route, { items, nextCursor: old ? null : 'synthetic-comments-older' });
            }
          }
          if (p === `/api/stories/${f.story.id}/comments` && method === 'POST') {
            assert.equal(req.postDataJSON().body, 'Nội dung giữ khi lỗi');
            if (s.failAdd) return fault(503);
            s.added = true; return json(route, { ...f.comments[0], id: id(999), body: 'Nội dung giữ khi lỗi' });
          }
          if (p.startsWith(`/api/stories/${f.story.id}/comments/`) && method === 'DELETE') { s.deleted = true; return json(route, null); }
          blocked.push({ label, method, path: p }); return route.abort('blockedbyclient');
        } catch (error) { errors.push({ label, type: 'mock', message: h.sanitize(error.message) }); await route.abort('failed').catch(() => {}); }
      });
      const page = currentPage = await context.newPage();
      page.setDefaultTimeout(12000);
      await page.clock.setFixedTime(new Date(fixedTime));
      page.on('pageerror', error => errors.push({ label, type: 'pageerror', message: h.sanitize(error.message) }));
      page.on('response', res => { if (res.status() >= 400) errors.push({ label, type: 'http', path: new URL(res.url()).pathname, status: res.status() }); });
      page.on('console', msg => { if (msg.type() === 'error') { let p; try { p = new URL(msg.location().url).pathname; } catch {} errors.push({ label, type: 'console', path: p, message: h.sanitize(msg.text()) }); } });
      page.on('requestfailed', req => { if (!closing && req.failure()?.errorText !== 'net::ERR_ABORTED') errors.push({ label, type: 'requestfailed', path: new URL(req.url()).pathname }); });
      const openLedger = async () => {
        await page.goto(`${h.baseURL}/profile`);
        await page.getByRole('heading', { name: /Lịch sử Xu \/ EXP/ }).getByRole('button', { name: 'Xem', exact: true }).click();
      };
      stage = `${label}:ledger-loading-pages`;
      s.ledger = 'hold'; await openLedger(); await until(() => s.ledgerReads > 0, 'ledger request held');
      assert.equal(await page.locator('.list__label').filter({ hasText: 'Điểm danh đủ đôi' }).count(), 0);
      await shot(page, `${label}-ledger-loading`); s.ledger = 'normal'; releaseLedger();
      await until(() => page.getByText('Điểm danh đủ đôi · Xu của bạn', { exact: true }).count().then(n => n === 4), '20 ledger rows');
      const ledgerNav = page.getByRole('navigation', { name: 'Phân trang lịch sử ví' });
      assert.equal(await ledgerNav.locator('..').locator('.list > .list__item').count(), 20);
      await page.getByText(/Chính sách v2/).first().waitFor();
      await ledgerNav.getByRole('button', { name: 'Cũ hơn', exact: true }).click();
      await page.getByText('Đang xem lịch sử cũ.', { exact: true }).waitFor();
      await until(() => ledgerNav.getByRole('button', { name: 'Cũ hơn', exact: true }).isDisabled(), 'tail page');
      await ledgerNav.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await shot(page, `${label}-ledger-older`);
      await ledgerNav.getByRole('button', { name: 'Mới hơn', exact: true }).click();
      await page.getByText('Đang xem lịch sử cũ.', { exact: true }).waitFor({ state: 'hidden' });
      await ledgerNav.getByRole('button', { name: 'Cũ hơn', exact: true }).click();
      await ledgerNav.getByRole('button', { name: 'Mới nhất', exact: true }).click();
      checks.push(stage);
      stage = `${label}:ledger-empty-error-retry`;
      s.ledger = 'empty'; await openLedger(); await page.getByText('Chưa có giao dịch', { exact: true }).waitFor(); await shot(page, `${label}-ledger-empty`);
      s.ledger = 'error'; await openLedger(); await page.getByRole('button', { name: 'Thử lại', exact: true }).waitFor();
      await until(() => page.getByRole('button', { name: 'Thử lại', exact: true }).isEnabled(), 'retry ready');
      await shot(page, `${label}-ledger-error`); s.ledger = 'normal'; await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
      await page.getByText('Điểm danh đủ đôi · Xu của bạn', { exact: true }).first().waitFor(); checks.push(stage);
      stage = `${label}:comments-order-draft-focus`;
      await page.goto(`${h.baseURL}/stories/${f.story.id}`);
      const section = page.getByRole('region', { name: 'Bình luận', exact: true });
      await section.locator('.comment').nth(19).waitFor();
      assert.equal(await section.locator('.comment__body').first().innerText(), 'Bình luận synthetic 21');
      const input = page.getByRole('textbox', { name: 'Viết bình luận', exact: true });
      await page.getByRole('button', { name: 'Bình luận', exact: true }).click();
      assert(await input.evaluate(el => document.activeElement === el));
      await input.fill('Nội dung giữ khi lỗi');
      await page.reload(); await until(() => input.inputValue().then(v => v === 'Nội dung giữ khi lỗi'), 'couple draft restored after reload');
      checks.push(`${label}:comment-draft-reload`);
      await section.getByRole('button', { name: 'Bình luận cũ hơn', exact: true }).click();
      await section.getByText('Bình luận synthetic 01', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Nội dung giữ khi lỗi');
      await page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
      await section.getByRole('alert').waitFor();
      assert.equal(await input.inputValue(), 'Nội dung giữ khi lỗi');
      await until(() => section.getByRole('alert').evaluate(el => document.activeElement === el), 'failed submit error focus');
      await shot(page, `${label}-comments-failed-draft`); checks.push(stage);
      stage = `${label}:comments-success-from-history`;
      s.failAdd = false;
      await page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
      await section.locator('.comment__body').filter({ hasText: /^Nội dung giữ khi lỗi$/ }).waitFor();
      await until(() => input.inputValue().then(value => value === ''), 'successful submit clears draft'); assert.equal(await section.locator('.comment').count(), 20);
      assert.equal(await section.getByRole('button', { name: 'Mới nhất', exact: true }).count(), 0);
      await shot(page, `${label}-comments-newest`); checks.push(stage);
      stage = `${label}:comments-delete-empty-history`;
      await section.getByRole('button', { name: 'Bình luận cũ hơn', exact: true }).click();
      await section.getByText('Bình luận synthetic 01', { exact: true }).waitFor();
      await section.getByRole('button', { name: 'Xóa', exact: true }).first().click();
      await page.getByRole('dialog', { name: 'Xóa bình luận?', exact: true }).getByRole('button', { name: 'Xóa', exact: true }).click();
      await section.getByText('Trang này không còn bình luận. Hãy quay về trang mới hơn.', { exact: true }).waitFor();
      await shot(page, `${label}-comments-empty-history`);
      await section.getByRole('button', { name: 'Mới nhất', exact: true }).click();
      await section.getByText('Nội dung giữ khi lỗi', { exact: true }).waitFor(); checks.push(stage);
      stage = `${label}:comments-live-access-denial`;
      s.comments = 'denied';
      // One real 20-second active-page poll; no private query-client test hook.
      await section.getByText('Không tải được bình luận.', { exact: false }).waitFor({ timeout: 35000 });
      assert.equal(await section.locator('.comment').count(), 0, 'Access error must hide cached private rows');
      await shot(page, `${label}-comments-denied`); checks.push(stage);
      closing = true; await context.close(); closing = false;
    }
    assert.deepEqual(blocked, []);
    const budgets = new Map();
    for (const f of faults) for (const type of ['http', 'console']) { const key = `${f.label}|${type}|${f.path}|${f.status}`; budgets.set(key, (budgets.get(key) ?? 0) + 1); }
    const unexpected = [];
    for (const e of errors) {
      const match = e.type === 'console' && /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(e.message);
      const key = `${e.label}|${e.type}|${e.path}|${e.status ?? (match ? Number(match[1]) : 0)}`;
      if ((budgets.get(key) ?? 0) > 0) budgets.set(key, budgets.get(key) - 1); else unexpected.push(e);
    }
    assert.deepEqual(unexpected, [], 'Unexpected browser errors');
    assert.deepEqual([...budgets].filter(([, n]) => n), [], 'Every injected HTTP/console error observed');
    await h.writeResult({ ok: true, mockOnly: true, checks, inventory, errors, faults, blocked, requests, limitations: ['Synthetic browser integration only; not backend ACL, Mongo cost, real device or throughput evidence.', 'Deletion response models an empty historical page; not a concurrent database deletion test.', 'A single real active-page poll verifies stale-data hiding after access denial; no account-switch or actual realtime server test.'] });
    console.log(`PASS ${checks.length} history UI checks; evidence: ${h.evidenceDir}`);
  } catch (error) {
    await h.screenshot(currentPage, 'failure', { fullPage: false }).catch(() => {});
    const failure = h.sanitize(String(error?.message ?? error));
    await h.writeResult({ ok: false, mockOnly: true, stage, failure, checks, inventory, errors, faults, blocked, requests });
    console.error(`${failure}\nEvidence: ${h.evidenceDir}`); process.exitCode = 1;
  } finally { closing = true; await browser?.close(); }
}
