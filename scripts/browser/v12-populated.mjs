// Visual stress fixtures injected only in browser GET responses. Not API/protocol proof.
// Requires an existing private synthetic baseline fixture; never starts/stops services.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
async function main() {
process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-populated-${Date.now()}`);
const h = await import('./harness.mjs');
const checks = [], errors = [], inventory = [], cls = [];
let browser;
const windows = [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }];
async function respond(route, data) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
}
async function capture(page, key, state, viewport, { fullPage = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await h.noOverflow(page);
  const file = `${key}-${state}-${viewport.width}`;
  await h.screenshot(page, file, { fullPage });
  inventory.push({ key, state, viewport, screenshot: `${file}.png`, fullPage, review: 'capture only; manual review pending', fixture: 'browser-injected synthetic GET DTO; not server population proof' });
}
try {
  h.assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
  const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
  h.assert(fixture.synthetic && fixture.users?.length === 2, 'Synthetic paired fixture required');
  const [owner, partner] = fixture.users;
  const login = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
  const { ledger, stories } = makeFixture(owner, partner, h.baseURL);
  validateFixture(ledger, stories);
  browser = await h.openBrowser();
  for (const viewport of windows) {
    const { context, page } = await h.fresh(browser, `populated-${viewport.width}`, errors);
    await page.setViewportSize(viewport);
    await context.addInitScript(({ login }) => {
      localStorage.setItem('lw.accessToken', login.accessToken); localStorage.setItem('lw.refreshToken', login.refreshToken); localStorage.setItem('lw.space', 'friends');
    }, { login });
    await context.addInitScript(() => {
      window.__labShifts = { supported: false, entries: [], dropped: 0 };
      try {
        if (!PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) return;
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            if (window.__labShifts.entries.length < 1000) window.__labShifts.entries.push({ time: entry.startTime, value: entry.value, scrollY: window.scrollY, sources: (entry.sources ?? []).slice(0, 5).map(source => {
              const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
              return { tag: source.node?.tagName ?? null, class: typeof source.node?.className === 'string' ? source.node.className.slice(0, 100) : null, previous: rect(source.previousRect), current: rect(source.currentRect) };
            }) });
            else window.__labShifts.dropped++;
          }
        });
        observer.observe({ type: 'layout-shift', buffered: true });
        window.__labShifts.supported = true;
      } catch {}
    });
    // Mutations to synthetic IDs are prohibited; all interaction below is display-only.
    await context.route('**/api/friends/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() !== 'GET') {
        if (url.pathname.startsWith('/api/friends/outings') || url.pathname.startsWith('/api/friends/stories')) {
          errors.push({ type: 'unexpected-fixture-mutation', path: url.pathname });
          return route.abort();
        }
        return route.continue();
      }
      if (url.pathname === `/api/friends/outings/${ledger.id}`) return respond(route, ledger);
      if (url.pathname === '/api/friends/stories') {
        const cursor = url.searchParams.get('cursor');
        return respond(route, storyPage(stories, cursor));
      }
      await route.continue();
    });
    await page.goto(`${h.baseURL}/friends`);
    await page.locator('article.post').first().waitFor();
    // The end marker exists only after the sentinel fetches the second page.
    for (let attempt = 0; attempt < 12 && await page.locator('article.post').count() < 12; attempt++) {
      await page.locator('article.post').last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await page.locator('.feed-end').waitFor({ timeout: 5000 });
    h.assert.equal(await page.locator('article.post').count(), 12, 'Both synthetic feed pages must render 12 posts');
    h.assert.equal(await page.locator('article.post img').count(), 12, 'Each synthetic post must render its image');
    const longPost = page.locator('article.post').filter({ hasText: 'Nội dung dài synthetic' }).first();
    await longPost.getByRole('button', { name: 'Xem thêm', exact: true }).click();
    h.assert.equal(await longPost.locator('.post__body p.is-clamped').count(), 0, 'Long body must be expanded');
    // Trigger lazy loads in view before decoding each synthetic image.
    const images = page.locator('article.post img');
    for (let i = 0; i < 12; i++) {
      await images.nth(i).scrollIntoViewIfNeeded();
      await images.nth(i).evaluate(async image => {
        await image.decode();
        if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error('Synthetic image failed to load');
      });
    }
    await longPost.scrollIntoViewIfNeeded();
    await capture(page, 'R30', 'long-body-expanded', viewport, { fullPage: false });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, 'R30', 'long-image-feed-top-expanded', viewport, { fullPage: false });
    await page.locator('.feed-end').scrollIntoViewIfNeeded();
    await capture(page, 'R30', 'long-image-feed-bottom-expanded', viewport, { fullPage: false });
    h.assert.equal(await page.locator('.feed-end').count(), 1);
    checks.push(`R30 ${viewport.width}: 2 synthetic pages/12 image posts, expanded long body, viewport top+bottom no overflow`);
    cls.push(await readCls(page, 'friends-feed', viewport));
    await page.goto(`${h.baseURL}/friends/outings/${ledger.id}`);
    await page.getByRole('heading', { name: ledger.title, exact: true }).waitFor();
    h.assert.equal(await page.locator('.outing-expense').count(), 100, '100 active expenses must render');
    h.assert.equal(await page.locator('.outing-hero__total').getByText(/10\.000\.000\.000/).count(), 1, 'Ten-billion total must be visible');
    h.assert.equal(await page.locator('.outing-hero__balance').getByText(/9\.800\.000\.000/).count(), 1, 'Large balance must be visible');
    await capture(page, 'N02', 'large-amount-expense', viewport);
    await page.getByRole('button', { name: 'Thành viên', exact: true }).click();
    h.assert.equal(await page.locator('.outing-person').count(), 50, 'All 50 members must render');
    await capture(page, 'N02', '50-members', viewport);
    await page.locator('.outing-person').last().scrollIntoViewIfNeeded();
    await capture(page, 'N02', '50-members-last', viewport, { fullPage: false });
    cls.push(await readCls(page, 'outing-detail', viewport));
    checks.push(`N02 ${viewport.width}: 50 members and 10-billion total render; last member reachable`);
    await context.close();
  }
  h.assert.deepEqual(errors, [], 'Unexpected browser errors');
  await h.writeResult({ ok: true, checks, inventory, errors, cls, limitations: ['Browser-injected GET DTOs only, not real 50-account API/ACL/cap proof', 'Icon image is a local deterministic synthetic image, not photography acceptance', 'No mutation, consent or settlement outcome proof', 'Captures require manual image review; no automatic visual PASS', 'CLS is bounded lab-only, selected navigation windows and interactions; not field or full-app evidence; no contrast claim'] });
  console.log(`PASS ${checks.length} display checks; ${inventory.length} captures; ${h.evidenceDir}`);
} catch (error) {
  await h.writeResult({ ok: false, checks, inventory, errors, failure: h.sanitize(error.message) });
  console.error(h.sanitize(error.message)); process.exitCode = 1;
} finally { await browser?.close(); }

}

export function makeFixture(owner, partner, baseURL) {
  const id = number => number.toString(16).padStart(24, '0');
  const at = '2026-11-13T02:00:00.000Z';
  const members = Array.from({ length: 50 }, (_, i) => ({ userId: i === 0 ? owner.id : i === 1 ? partner.id : id(100 + i), displayName: i === 0 ? owner.displayName : `Thành viên ${i + 1} có tên dài kiểm tra bố cục`, status: 'accepted', consent: null }));
  const amount = 10_000_000_000;
  const share = amount / members.length;
  const balances = members.map((member, i) => ({ userId: member.userId, paid: i === 0 ? amount : 0, share, sent: 0, received: 0, balance: (i === 0 ? amount : 0) - share, reservedOutgoing: 0, reservedIncoming: 0 }));
  const ledger = {
    access: 'full', id: id(900), title: 'Buổi chia tiền có 50 thành viên và tổng tiền mười tỷ đồng để kiểm tra khả năng đọc trên màn hình nhỏ', outingDate: '2026-11-13', creatorId: owner.id,
    myMembership: 'accepted', revision: 151, financeRevision: 101, phase: 'collecting', createdAt: at, participants: members, balances,
    expenses: Array.from({ length: 100 }, (_, index) => ({ id: id(2000 + index), payerId: owner.id, title: `Khoản ${index + 1}: phương tiện, ăn uống và nơi nghỉ của cả nhóm trong chuyến đi kiểm thử`, amount: 100_000_000, splitMode: 'equal', participantIds: members.map(p => p.userId), allocations: members.map(p => ({ userId: p.userId, amount: 2_000_000 })), status: 'active', createdAt: at, updatedAt: at })),
    settlements: [], suggestions: [], totalExpenses: amount, eventId: null,
    capacity: { participants: { used: 50, max: 50 }, expenses: { used: 100, max: 200 }, settlements: { used: 0, max: 500 }, edits: { used: 0, max: 1000 }, ordinaryOperations: { used: 151, max: 3000 }, reservedOperations: { used: 0, max: 1052 }, editsFrozen: false, finalSettlementSlots: false },
  };
  const stories = Array.from({ length: 12 }, (_, i) => ({
    id: id(1000 + i), author: { id: partner.id, displayName: 'Tên người đăng khá dài để kiểm tra xuống dòng', avatarUrl: null }, isMine: false,
    body: `${i + 1}. Một chuyến đi nhiều kỷ niệm. ${'Nội dung dài synthetic kiểm tra nhịp đọc, khoảng cách và xuống dòng trên điện thoại. '.repeat(i % 3 === 0 ? 8 : 2)}`,
    photos: [{ key: `synthetic-${i}`, url: `${baseURL}/icons/icon-512.png`, width: 512, height: 512 }],
    reactions: { mine: null, total: 42 + i, top: ['love'] }, commentCount: 0, poll: null, createdAt: at, editedAt: null,
  }));
  return { ledger, stories };
}

export function storyPage(stories, cursor) {
  if (cursor == null) return { items: stories.slice(0, 10), nextCursor: 'v12-page-2' };
  if (cursor === 'v12-page-2') return { items: stories.slice(10, 12), nextCursor: null };
  throw new Error(`Unexpected synthetic cursor: ${cursor}`);
}

export function validateFixture(ledger, stories) {
  assert.equal(ledger.participants.length, 50);
  assert.equal(new Set(ledger.participants.map(p => p.userId)).size, 50);
  assert.equal(ledger.expenses.length, 100);
  assert.ok(ledger.expenses.every(e => e.amount > 0 && e.amount <= 100_000_000 && e.allocations.reduce((sum, a) => sum + a.amount, 0) === e.amount));
  assert.equal(ledger.expenses.reduce((sum, e) => sum + e.amount, 0), 10_000_000_000);
  assert.equal(ledger.totalExpenses, 10_000_000_000);
  assert.equal(ledger.balances.length, 50);
  assert.equal(ledger.balances.reduce((sum, b) => sum + b.balance, 0), 0);
  assert.equal(stories.length, 12);
  assert.equal(new Set(stories.map(s => s.id)).size, 12);
  const first = storyPage(stories, null), second = storyPage(stories, first.nextCursor);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items], stories);
}

export function summarizeShifts(entries) {
  let rawSum = 0, maxSessionWindow = 0, windowSum = 0, start = 0, last = 0;
  for (const { time, value } of entries) {
    rawSum += value;
    if (!windowSum || time - last >= 1000 || time - start >= 5000) { start = time; windowSum = 0; }
    windowSum += value; last = time;
    maxSessionWindow = Math.max(maxSessionWindow, windowSum);
  }
  return { rawSum, maxSessionWindow };
}
async function readCls(page, navigation, viewport) {
  const data = await page.evaluate(() => window.__labShifts);
  return { navigation, viewport, supported: data.supported, observedEntries: data.entries.length, entries: data.entries, droppedEntries: data.dropped, truncated: data.dropped > 0, ...summarizeShifts(data.entries), scope: 'lab-only; navigation to capture during scripted interactions, excludes shifts after recent input; not field or full app' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
