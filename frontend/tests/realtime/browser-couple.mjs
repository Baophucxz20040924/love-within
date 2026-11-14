// Owned localhost mock API (4002) and UI (5175) only. Does not start or stop either service.
// Two independent UI sessions; setup uses API, all measured mutations use the UI.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.LW_PW_HOME || path.join(process.env.TEMP || process.env.TMP, 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api';
const ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `realtime-couple-${Date.now()}`);
const run = randomBytes(5).toString('hex');
const title = `Quỹ SSE ${run}`;
const checks = [], errors = [], contexts = [];
let browser, activePage;
await mkdir(evidence, { recursive: true });

async function setupRequest(user, method, route, body) {
  // Allow setup only: measured mutations must be performed in the UI.
  assert.ok(route === '/auth/register' || route === '/pairing/invite' || /^\/pairing\/invites\/[a-f\d]+\/accept$/.test(route));
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `Setup ${method} ${route.replace(/[a-f\d]{24}/g, '[id]')} returned ${response.status}`);
  return (await response.json()).data;
}
async function account(name) {
  const email = `couple-sse-${run}-${name}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await setupRequest(null, 'POST', '/auth/register', { email, password, displayName: `SSE${name}` });
  return { email, password, token: auth.accessToken, name: `SSE${name}` };
}
async function session(user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(() => {
    // Record parsed SSE only in memory. Never write frames, headers, tokens or storage state to evidence.
    window.__sse = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (!String(args[0]).includes('/realtime?') || !response.ok || !response.body) return response;
      const decoder = new TextDecoder(); let pending = '';
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const event = /^event:\s*(.+)$/m.exec(frame)?.[1];
          const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
          if (event === 'ready') window.__sse.push({ event });
          if (data) try { const parsed = JSON.parse(data); window.__sse.push({ event, domains: parsed.domains || [] }); } catch { /* heartbeat or malformed data */ }
        }
        controller.enqueue(chunk);
      } })), { status: response.status, headers: response.headers });
    };
    // Keep reconnect/heartbeat timeouts real; disable known React Query polling intervals.
    const originalInterval = window.setInterval.bind(window);
    window.setInterval = (fn, delay, ...args) => originalInterval(fn, [20000, 30000, 60000].includes(delay) ? 3600000 : delay, ...args);
  });
  const page = await context.newPage(); user.page = page; user.context = context;
  page.on('pageerror', (error) => errors.push({ type: 'page', name: error.name }));
  await page.goto(`${ui}/login`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20000 });
  await page.waitForFunction(() => window.__sse.some((frame) => frame.event === 'ready'), null, { timeout: 10000 });
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const visible = (locator) => locator.waitFor({ state: 'visible', timeout: 5000 });
const hidden = (locator) => locator.waitFor({ state: 'hidden', timeout: 5000 });
async function mark(page) { return page.evaluate(() => window.__sse.length); }
async function waitDomain(page, index, domains) {
  await page.waitForFunction(({ index, domains }) => window.__sse.slice(index).some((frame) => frame.domains?.some((d) => domains.includes(d))),
    { index, domains }, { timeout: 5000 });
}
async function measured(name, page, domains, action, observe) {
  activePage = page;
  const index = await mark(page), start = Date.now();
  await action();
  await Promise.all([waitDomain(page, index, domains), observe()]);
  const ms = Date.now() - start;
  assert.ok(ms < 10000, `${name} exceeded polling-independent observation window`);
  checks.push({ name, ms }); console.log('PASS', name, `${ms}ms`);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled',
    mask: [page.locator('input[type=email],input[type=password]')] });
}
async function go(page, route) { await page.goto(`${ui}${route}`); }
function total(page) { return page.getByRole('region', { name: 'Tiến độ quỹ', exact: true }).locator('.savings-progress__amount'); }

try {
  const a = await account('A'), b = await account('B');
  const invite = await setupRequest(a, 'POST', '/pairing/invite', { toEmail: b.email });
  await setupRequest(b, 'POST', `/pairing/invites/${invite.id}/accept`, {});
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
  await session(a); await session(b);

  // Warm B's Home, then modify A's mood through its picker.
  await visible(b.page.getByText('SSEA chưa chọn cảm xúc', { exact: true }));
  await measured('Partner mood appears on Home via SSE', b.page, ['moods'], async () => {
    await button(a.page, 'Chọn cảm xúc hôm nay của bạn').click();
    await a.page.getByRole('dialog').getByRole('radio').first().click();
    await button(a.page, 'Lưu').click();
  }, async () => { await visible(b.page.locator('.hero-row--partner[aria-label]')); });
  await shot(b.page, 'mood-live');

  await go(a.page, '/quests'); await go(b.page, '/quests');
  await visible(b.page.getByText('SSEA chưa điểm danh', { exact: true }));
  await measured('Partner check-in appears in quests via SSE', b.page, ['quests', 'couple', 'wallet'],
    async () => button(a.page, 'Điểm danh hôm nay').click(),
    async () => visible(b.page.getByText('SSEA đã điểm danh', { exact: true })));
  await shot(b.page, 'checkin-live');

  // Both views stay mounted: B sees a new approval and A sees the approved goal.
  await go(a.page, '/savings'); await go(b.page, '/approvals');
  await visible(a.page.getByText('Chưa có quỹ chung', { exact: true }));
  await visible(b.page.getByText('Không có gì cần bạn duyệt', { exact: true }));
  await measured('New savings proposal appears in partner approvals via SSE', b.page, ['proposals'], async () => {
    await button(a.page, 'Tạo quỹ').click();
    const sheet = a.page.getByRole('dialog', { name: 'Đề xuất quỹ mới', exact: true });
    await sheet.getByLabel('Tên quỹ', { exact: true }).fill(title);
    await sheet.getByLabel('Mục tiêu (VND)', { exact: false }).fill('1000000');
    await sheet.getByRole('button', { name: 'Gửi đề xuất', exact: true }).click();
    await hidden(sheet);
  }, async () => visible(b.page.locator('.approval').filter({ hasText: title })));
  await measured('Approved savings goal appears in author list via SSE', a.page, ['proposals', 'savings'],
    async () => b.page.locator('.approval').filter({ hasText: title }).getByRole('button', { name: 'Đồng ý', exact: true }).click(),
    async () => visible(a.page.getByRole('heading', { name: new RegExp(title) })));
  await shot(a.page, 'savings-approved-live');

  await a.page.getByRole('link').filter({ has: a.page.getByRole('heading', { name: new RegExp(title) }) }).click();
  await visible(button(a.page, 'Góp tiền'));
  const goalPath = new URL(a.page.url()).pathname;
  assert.match(goalPath, /^\/savings\/[^/]+$/);
  await go(b.page, goalPath); await visible(button(b.page, 'Góp tiền'));
  await visible(total(b.page).filter({ hasText: '0' }));
  // Keep B's unsent contribution draft open while A commits a different contribution.
  await button(b.page, 'Góp tiền').click();
  const draft = b.page.getByRole('dialog', { name: 'Góp tiền', exact: true });
  await draft.getByLabel('Số tiền (VND)', { exact: true }).fill('25000');
  await draft.getByLabel('Ghi chú', { exact: false }).fill('B draft remains');
  await measured('Savings contribution updates partner total and preserves open draft', b.page, ['savings'], async () => {
    await button(a.page, 'Góp tiền').click();
    const sheet = a.page.getByRole('dialog', { name: 'Góp tiền', exact: true });
    await sheet.getByLabel('Số tiền (VND)', { exact: true }).fill('100000');
    await sheet.getByLabel('Ghi chú', { exact: false }).fill(`SSE contribution ${run}`);
    await sheet.getByRole('button', { name: 'Lưu khoản góp', exact: true }).click();
    await hidden(sheet);
  }, async () => {
    await visible(total(b.page).filter({ hasText: '100.000' }));
    assert.equal(await draft.getByLabel('Số tiền (VND)', { exact: true }).inputValue(), '25000');
    assert.equal(await draft.getByLabel('Ghi chú', { exact: false }).inputValue(), 'B draft remains');
  });
  await shot(b.page, 'savings-live-with-draft');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors,
    scope: 'Local mock API/UI, polling intervals disabled; no CDN, physical device or multiworker claim.' }, null, 2));
  console.log('Evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true,
    mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
  const failure = String(error?.message || 'Failure').split('\nCall log:')[0]
    .replace(/Bearer\s+\S+/gi, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, failure }, null, 2));
  console.error(failure); console.log('Evidence:', evidence); process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
