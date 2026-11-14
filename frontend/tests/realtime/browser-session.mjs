// Local disposable mock runtime only: API 4002, Vite 5175. No saved credentials or artifacts.
// Run separately with LW_PW_HOME pointing at the external playwright-core installation.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const home = process.env.LW_PW_HOME || path.join(process.env.TEMP || process.env.TMP, 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const run = randomBytes(5).toString('hex');
const errors = [];
async function request(user, method, route, body) {
  const res = await fetch(api + route, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(res.ok, `${method} ${route.split('?')[0]} returned ${res.status}`);
  return (await res.json()).data;
}
async function account(label) {
  const email = `sse-race-${run}-${label}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: `Race ${label}` });
  const user = { email, password, token: auth.accessToken };
  await request(user, 'POST', '/friends/join', {});
  return user;
}
async function login(page, user) {
  await page.waitForURL(url => url.pathname === '/login');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
  await page.waitForURL('**/friends/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/friends');
}
let browser, context;
try {
  const a = await account('A'), b = await account('B');
  const marker = `Private race post ${run}`;
  const post = await request(a, 'POST', '/friends/stories', { body: marker, photos: [] });
  browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__raceReady = 0;
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!String(args[0]).includes('/realtime?') || !response.ok || !response.body) return response;
      const decoder = new TextDecoder(); let pending = '';
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        while (pending.includes('\n\n')) {
          const boundary = pending.indexOf('\n\n');
          if (pending.slice(0, boundary).includes('event: ready')) window.__raceReady++;
          pending = pending.slice(boundary + 2);
        }
        controller.enqueue(chunk);
      } })), { status: response.status, headers: response.headers });
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.name));
  await page.goto(ui + '/login');
  await login(page, a);
  await page.waitForFunction(() => window.__raceReady >= 1);
  await page.goto(`${ui}/friends/posts/${post.id}`);
  await page.getByText(marker, { exact: true }).waitFor();
  await page.waitForFunction(() => window.__raceReady >= 1);

  // route.fetch obtains A's real response while its original browser request is held.
  // SPA navigation must retain that request. If browser cancellation removes it, report
  // SKIP explicitly; never claim the stale-response race was proven.
  let release, capturedResolve, finishedResolve;
  const gate = new Promise(resolve => { release = resolve; });
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const finished = new Promise(resolve => { finishedResolve = resolve; });
  let delivery = 'not attempted';
  const pattern = `**/api/friends/stories/${post.id}`;
  await page.route(pattern, async route => {
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      capturedResolve(true);
      await gate;
      await route.fulfill({ response });
      delivery = 'delivered';
    } catch {
      delivery = 'cancelled';
      capturedResolve(false);
    } finally { finishedResolve(); }
  });
  // Generate a genuine mounted-query refetch via a second-device mutation and SSE.
  // This keeps the current SPA document alive through logout/login.
  await request(a, 'POST', `/friends/stories/${post.id}/comments`, { body: `Race trigger ${run}` });
  assert.equal(await Promise.race([captured, new Promise(resolve => setTimeout(() => resolve(false), 10000))]), true, 'could not capture real A response');
  await page.getByRole('link', { name: 'Tôi', exact: true }).click();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await login(page, b);
  await page.waitForFunction(() => window.__raceReady >= 2, null, { timeout: 15000 });
  release();
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (delivery !== 'delivered') {
    console.log('SKIP delayed A fetch delivery: browser cancelled the request during account switch; unit tests cover the guard.');
  } else {
    await page.waitForTimeout(500);
    assert.equal(await page.getByText(marker, { exact: true }).count(), 0, 'account A private post visible to B');
    await page.unroute(pattern);
    await page.evaluate((id) => history.pushState(null, '', `/friends/posts/${id}`), post.id);
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await page.getByText('Bài viết không còn nữa', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText(marker, { exact: true }).count(), 0, 'old response repopulated the B detail cache');
    console.log('PASS delayed A HTTP response delivered after B login; no A private post shown or cached');
  }
  // Independently verify B cannot access A's private post via the real REST ACL.
  const denied = await fetch(`${api}/friends/stories/${post.id}`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.ok([403, 404].includes(denied.status), `B unexpectedly received HTTP ${denied.status}`);
  assert.deepEqual(errors, [], 'uncaught page errors');
  console.log('PASS two users, same-context logout/login, fresh authenticated ready and B REST isolation');
} catch (error) {
  console.error(String(error?.message || 'Browser session test failed').split('\nCall log:')[0].replaceAll(/sse-race-[\w-]+@example\.test/g, '[synthetic email]'));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
