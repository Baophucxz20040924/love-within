// Local owned mock runtime only (API 4002, Vite 5175). No provider, persisted tokens or storageState.
// Run separately from browser.mjs after starting the disposable mock runtime and Vite.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.LW_PW_HOME || path.join(process.env.TEMP || process.env.TMP, 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `realtime-outing-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const checks = [], errors = [], contexts = [];
let browser, activePage;
const run = randomBytes(5).toString('hex');
const op = () => randomBytes(16).toString('hex');
async function request(user, method, route, body) {
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${route.split('?')[0]} returned ${response.status}`);
  return (await response.json()).data;
}
async function account(name) {
  const email = `sse-${run}-${name}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: `SSE ${name}` });
  const user = { email, password, token: auth.accessToken, name: `SSE ${name}` };
  await request(user, 'POST', '/friends/join', {});
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function session(user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__sse = [];
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (!String(args[0]).includes('/realtime?') || !response.ok || !response.body) return response;
      const decoder = new TextDecoder();
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        window.__sse.push({ at: Date.now(), text: decoder.decode(chunk, { stream: true }) });
        controller.enqueue(chunk);
      } })), { status: response.status, headers: response.headers });
    };
    // Disable known React Query polling intervals; SSE heartbeat/reconnect timers stay real.
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, delay, ...args) => interval(fn, [20000, 30000, 60000].includes(delay) ? 3600000 : delay, ...args);
  });
  const page = await context.newPage(); user.page = page; user.context = context;
  page.on('pageerror', (error) => errors.push({ type: 'page', name: error.name }));
  await page.goto(ui + '/login');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
  await page.waitForURL('**/friends/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/friends');
  await page.waitForFunction(() => window.__sse.some((frame) => frame.text.includes('event: ready')));
  return user;
}
async function measured(name, fn) {
  const start = Date.now(); await fn(); const ms = Date.now() - start;
  checks.push({ name, ms }); console.log('PASS', name, `${ms}ms`);
}
async function mark(page) { return page.evaluate(() => window.__sse.length); }
async function waitDomain(page, since, domain) {
  await page.waitForFunction(({ since, domain }) => window.__sse.slice(since).some((frame) => frame.text.includes(domain)), { since, domain }, { timeout: 4000 });
}
async function visible(page, text) { await page.getByText(text, { exact: true }).waitFor({ timeout: 4000 }); }
async function shot(page, name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, mask: [page.locator('input[type=email],input[type=password]')] }); }
async function detail(user, id) { return request(user, 'GET', `/friends/outings/${id}`); }
async function mutate(user, id, action, revision, fields = {}) {
  return request(user, 'POST', `/friends/outings/${id}/${action}`, { operationId: op(), expectedRevision: revision, ...fields });
}
try {
  const a = await account('A'), b = await account('B'), c = await account('C');
  const pending = await request(a, 'POST', '/friends/requests', { userId: b.id });
  await request(b, 'POST', `/friends/requests/${pending.requestId}/accept`, {});
  browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
  await session(a); await session(b); await session(c);
  // A and B are friends; C is unrelated. Keep B's list query warm before membership exists.
  await b.page.goto(`${ui}/friends/outings`);
  await visible(b.page, 'Chia tiền');
  await c.page.goto(`${ui}/friends/outings`);
  await visible(c.page, 'Chia tiền');
  const title = `SSE outing ${run}`, expenseTitle = `SSE expense ${run}`;
  let outingId;
  let cMark = await mark(c.page), bMark = await mark(b.page);
  activePage = b.page;
  await measured('Create a ledger without a minimum member selection in UI', async () => {
    await a.page.goto(`${ui}/friends/outings`);
    await a.page.getByRole('button', { name: 'Tạo buổi chia tiền', exact: true }).click();
    const sheet = a.page.getByRole('dialog', { name: 'Tạo buổi chia tiền', exact: true });
    await sheet.getByLabel('Tên buổi', { exact: true }).fill(title);
    await sheet.getByLabel('Ngày đi chơi', { exact: true }).fill('2026-11-15');
    await sheet.getByRole('button', { name: 'Tạo buổi chia tiền', exact: true }).click();
    await a.page.waitForURL(url => /\/friends\/outings\/[^/]+$/.test(url.pathname));
    outingId = new URL(a.page.url()).pathname.split('/').at(-1);
    await visible(a.page, title);
  });
  await measured('Add member in UI; joined ledger appears live without an invitation acceptance', async () => {
    await a.page.getByRole('button', { name: 'Thành viên', exact: true }).click();
    await a.page.getByRole('button', { name: 'Thêm thành viên', exact: true }).click();
    const sheet = a.page.getByRole('dialog', { name: 'Thêm thành viên', exact: true });
    await sheet.getByRole('checkbox', { name: b.name }).check();
    await sheet.getByRole('button', { name: 'Thêm thành viên', exact: true }).click();
    await sheet.waitFor({ state: 'hidden', timeout: 4000 });
    await waitDomain(b.page, bMark, 'friend-outings');
    await visible(b.page, title);
    assert.equal(await b.page.getByText('Chờ bạn nhận lời', { exact: true }).count(), 0);
    await b.page.getByRole('link').filter({ hasText: title }).click();
    await visible(b.page, 'Chưa có khoản chi nào');
    assert.equal(await b.page.getByRole('button', { name: 'Nhận lời tham gia', exact: true }).count(), 0);
    const joined = await detail(b, outingId);
    assert.equal(joined.access, 'full');
    assert.equal(joined.myMembership, 'accepted');
    assert.equal(joined.participants.find(member => member.userId === b.id).consent, null, 'membership must not consent to debt');
  });
  bMark = await mark(b.page); activePage = b.page;
  await measured('Expense and financial revision update other ledger live', async () => {
    const current = await detail(a, outingId);
    const beforeRevision = current.financeRevision;
    await mutate(a, outingId, 'expenses', current.revision, { title: expenseTitle, amount: 100000, splitMode: 'equal', participantIds: [a.id, b.id] });
    await waitDomain(b.page, bMark, 'friend-outings');
    await visible(b.page, expenseTitle);
    await b.page.getByText(`Phiên bản tiền ${beforeRevision + 1}`, { exact: true }).waitFor({ timeout: 4000 });
    await b.page.getByText('50.000đ', { exact: true }).first().waitFor({ timeout: 4000 });
  });
  await shot(b.page, 'outing-live-expense');
  await measured('Prepared expense keeps draft and rejects stale revision instead of silently rebasing', async () => {
    await b.page.getByRole('button', { name: 'Thêm chi phí', exact: true }).click();
    const sheet = b.page.getByRole('dialog', { name: 'Thêm chi phí', exact: true });
    await sheet.getByPlaceholder('Bữa tối, cà phê, vé xem phim…').fill('B prepared draft');
    await sheet.locator('.outing-money-input').fill('20000');
    const current = await detail(a, outingId);
    const start = await mark(b.page);
    await mutate(a, outingId, 'expenses', current.revision, { title: 'A concurrent expense', amount: 10000, splitMode: 'equal', participantIds: [a.id, b.id] });
    await waitDomain(b.page, start, 'friend-outings');
    // Check the mounted ledger underneath the portal, without refetching or reloading.
    await b.page.getByText('A concurrent expense', { exact: true }).waitFor({ timeout: 4000 });
    assert.equal(await sheet.getByPlaceholder('Bữa tối, cà phê, vé xem phim…').inputValue(), 'B prepared draft');
    const reply = b.page.waitForResponse(r => r.url().endsWith(`/friends/outings/${outingId}/expenses`) && r.request().method() === 'POST');
    await sheet.getByRole('button', { name: 'Lưu chi phí', exact: true }).click();
    assert.equal((await reply).status(), 409, 'prepared draft was silently rebased to a newer revision');
    await sheet.getByRole('button', { name: 'Tôi đã kiểm tra, sửa bản nháp', exact: true }).waitFor({ timeout: 4000 });
    assert.equal(await sheet.locator('.outing-money-input').inputValue(), '20000');
    await shot(b.page, 'outing-draft-revision-conflict');
    await sheet.getByRole('button', { name: 'Để sau', exact: true }).click();
    await b.page.getByRole('button', { name: 'Bỏ bản nháp', exact: true }).click();
  });
  await measured('Unfriend replaces warm ledger with restricted obligations live', async () => {
    const start = await mark(b.page);
    await request(a, 'DELETE', `/friends/${b.id}`);
    await b.page.waitForFunction((since) => window.__sse.slice(since).some((frame) => frame.text.includes('access')), start, { timeout: 4000 });
    await visible(b.page, 'Lịch sử tài chính hạn chế');
    await b.page.getByText(expenseTitle, { exact: true }).waitFor({ state: 'hidden', timeout: 4000 });
    await b.page.getByText('Khoản chi đã lưu', { exact: true }).first().waitFor({ timeout: 4000 });
    await b.page.getByText('55.000đ', { exact: true }).first().waitFor({ timeout: 4000 });
  });
  await shot(b.page, 'outing-restricted-obligation');
  await measured('Unrelated third user sees no outing or outing-specific hint', async () => {
    const frames = await c.page.evaluate((since) => window.__sse.slice(since).map((x) => x.text).join(''), cMark);
    assert.ok(!frames.includes('friend-outings'), 'unrelated user received outing invalidation');
    assert.equal(await c.page.getByText(title, { exact: true }).count(), 0);
    const response = await fetch(`${api}/friends/outings/${outingId}`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 404, 'unrelated user cannot read outing');
  });
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, scope: 'Local mock API/UI; polling disabled in test contexts. No physical-phone/CDN/multiworker proof.' }, null, 2));
  console.log('Evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
  const failure = String(error?.message || 'Failure').split('\nCall log:')[0].replaceAll(/sse-[\w-]+@example\.test/g, '[synthetic email]');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, failure }, null, 2));
  console.error(failure); console.log('Evidence:', evidence); process.exitCode = 1;
} finally { for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); }
