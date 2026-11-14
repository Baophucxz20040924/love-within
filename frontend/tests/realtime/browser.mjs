// Local owned mock runtime only: API4002, Vite5175. No provider calls, saved tokens or storageState.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const home = process.env.LW_PW_HOME || path.join(process.env.TEMP || process.env.TMP, 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `realtime-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const checks = [], errors = [], contexts = [];
let browser, activePage;
async function request(user, method, route, body) {
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${route.split('?')[0]} returned ${response.status}`);
  return (await response.json()).data;
}
const run = randomBytes(5).toString('hex');
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
      const url = String(args[0]);
      if (!url.includes('/realtime?') || !response.ok || !response.body) return response;
      const decoder = new TextDecoder();
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        window.__sse.push({ at: Date.now(), text });
        controller.enqueue(chunk);
      } })), { status: response.status, headers: response.headers });
    };
    // Deliberately disable React Query's known polling intervals in this proof.
    // Heartbeat/reconnect timeouts remain real; UI changes below must come from SSE.
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
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
async function visible(page, text) { await page.getByText(text, { exact: true }).waitFor({ timeout: 4000 }); }
async function shot(page, name) { await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, mask: [page.locator('input[type=email],input[type=password]')] }); }
async function measured(name, fn) { const start = Date.now(); await fn(); checks.push({ name, ms: Date.now() - start }); console.log('PASS', name, `${Date.now() - start}ms`); }
try {
  const a = await account('A'), b = await account('B'), c = await account('C');
  const pending = await request(a, 'POST', '/friends/requests', { userId: b.id });
  const post = await request(a, 'POST', '/friends/stories', { body: `SSE post ${run}`, photos: [] });
  browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
  await check('Three independent UI logins and authenticated ready frames', async () => { await session(a); await session(b); await session(c); });
  activePage = a.page;
  await a.page.goto(`${ui}/friends/u/${b.id}`);
  await a.page.getByRole('button', { name: 'Hủy lời mời', exact: true }).waitFor();
  await measured('Friend acceptance updates other live profile without polling/reload', async () => {
    await request(b, 'POST', `/friends/requests/${pending.requestId}/accept`, {});
    await a.page.getByRole('button', { name: 'Bạn bè', exact: true }).waitFor({ timeout: 4000 });
  });
  await a.page.goto(`${ui}/friends/posts/${post.id}`); await b.page.goto(`${ui}/friends/posts/${post.id}`);
  await visible(b.page, `SSE post ${run}`);
  const draft = 'B draft stays during live update';
  await b.page.getByPlaceholder('Viết bình luận…').fill(draft);
  activePage = b.page;
  await measured('UI comment appears for other user via SSE; unsent draft retained', async () => {
    await a.page.getByPlaceholder('Viết bình luận…').fill(`live comment ${run}`);
    await a.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
    await visible(b.page, `live comment ${run}`);
    assert.equal(await b.page.getByPlaceholder('Viết bình luận…').inputValue(), draft);
  });
  const root = (await request(a, 'GET', `/friends/stories/${post.id}/comments`))[0];
  await measured('Reply updates remote thread via SSE', async () => {
    await request(a, 'POST', `/friends/stories/${post.id}/comments`, { body: `live reply ${run}`, parentId: root.id });
    await visible(b.page, `live reply ${run}`);
  });
  await measured('Comment deletion removes remote comment and reply', async () => {
    await request(a, 'DELETE', `/friends/stories/${post.id}/comments/${root.id}`);
    await b.page.getByText(`live comment ${run}`, { exact: true }).waitFor({ state: 'hidden', timeout: 4000 });
    assert.equal(await b.page.getByText(`live reply ${run}`, { exact: true }).count(), 0);
  });
  await measured('Reaction count updates remote post via SSE', async () => {
    await request(a, 'PUT', `/friends/stories/${post.id}/reaction`, { type: 'love' });
    await b.page.locator('.post__reactions').getByText('1', { exact: true }).waitFor({ timeout: 4000 });
  });
  await shot(b.page, 'friends-live-with-draft');
  await check('Unrelated third user receives neither private post content nor post dirty hint', async () => {
    const frames = await c.page.evaluate(() => window.__sse.map((x) => x.text).join(''));
    assert.ok(!frames.includes('friend-posts'), 'private author activity reached unrelated viewer');
    assert.equal(await c.page.getByText(`SSE post ${run}`, { exact: true }).count(), 0);
  });
  await check('Offline missed update catches up on reconnect without manual reload', async () => {
    await b.context.setOffline(true); await b.page.waitForTimeout(200);
    await request(a, 'POST', `/friends/stories/${post.id}/comments`, { body: `missed comment ${run}` });
    await b.context.setOffline(false); await visible(b.page, `missed comment ${run}`);
    assert.equal(await b.page.getByPlaceholder('Viết bình luận…').inputValue(), draft);
  });
  await check('Portal draft stays mounted while offline; transient verification stays masked and retry is keyboard-accessible', async () => {
    await b.page.goto(`${ui}/friends/me`);
    await b.page.getByRole('button', { name: 'Thêm giới thiệu ngắn', exact: true }).click();
    const input = b.page.getByPlaceholder('VD: Mê cà phê, thích leo núi');
    await input.fill('Portal draft preserved across verification');
    let failMe = true;
    await b.page.route('**/api/me', async (route) => {
      if (failMe) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_TEMPORARY', message: 'Temporary local test failure' } }) });
      else await route.continue();
    });
    await b.context.setOffline(true);
    await b.page.locator('[data-realtime-verification]').getByRole('status').waitFor();
    assert.equal(await input.isVisible(), false, 'body portal escaped privacy mask');
    assert.equal(await input.inputValue(), 'Portal draft preserved across verification');
    await b.context.setOffline(false);
    const retry = b.page.locator('[data-realtime-verification]').getByRole('button', { name: 'Thử lại', exact: true });
    await retry.waitFor({ timeout: 20000 });
    assert.equal(await input.isVisible(), false, 'transient failure exposed retained content');
    await retry.focus();
    assert.equal(await retry.evaluate((el) => document.activeElement === el), true, 'modal trap captured retry focus');
    await shot(b.page, 'verification-retry-portal-masked');
    failMe = false;
    await retry.press('Enter');
    await input.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await input.inputValue(), 'Portal draft preserved across verification');
    await b.page.keyboard.press('Tab');
    assert.equal(await b.page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement)), true, 'modal focus trap did not resume');
    await b.page.unroute('**/api/me');
    await b.page.keyboard.press('Escape');
    await b.page.goto(`${ui}/friends/posts/${post.id}`);
    await visible(b.page, `SSE post ${run}`);
  });
  await measured('Block revocation removes already warm private post', async () => {
    await request(a, 'POST', '/friends/blocks', { userId: b.id });
    await b.page.getByText('Bài viết không còn nữa', { exact: true }).waitFor({ timeout: 4000 });
    assert.equal(await b.page.getByText(`SSE post ${run}`, { exact: true }).count(), 0);
  });
  await shot(b.page, 'revoked-private-post');
  await check('Missed offline revocation is reauthorized before warm content becomes visible', async () => {
    await request(a, 'DELETE', `/friends/blocks/${b.id}`);
    const renewed = await request(a, 'POST', '/friends/requests', { userId: b.id });
    await request(b, 'POST', `/friends/requests/${renewed.requestId}/accept`, {});
    await visible(b.page, `SSE post ${run}`);
    await b.context.setOffline(true);
    await b.page.locator('[data-realtime-verification]').getByRole('status').waitFor();
    await request(a, 'POST', '/friends/blocks', { userId: b.id });
    await b.context.setOffline(false);
    await b.page.getByText('Bài viết không còn nữa', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await b.page.getByText(`SSE post ${run}`, { exact: true }).count(), 0);
    await shot(b.page, 'missed-revocation-resync');
  });
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, scope: 'Local mock API/UI; polling disabled in test contexts. Not physical-phone/CDN/multiworker proof.' }, null, 2));
  console.log('Evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
  const failure = String(error?.message || 'Failure').split('\nCall log:')[0].replaceAll(/sse-[\w-]+@example\.test/g, '[synthetic email]');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, failure }, null, 2));
  console.error(failure); console.log('Evidence:', evidence); process.exitCode = 1;
} finally { for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); }
