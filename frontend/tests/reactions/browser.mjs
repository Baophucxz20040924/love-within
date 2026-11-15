// Source-only suite for operator-owned mock API4002 / UI5175. Start neither server here.
// Synthetic accounts remain in the local database. No HAR, trace, storage state or credentials are saved.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') {
  throw new Error('Explicit --local-mock-runtime opt-in required');
}
const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `reactions-${Date.now()}`);
const run = randomBytes(5).toString('hex'), contexts = [], pageErrors = [];
let browser, activePage;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function response(user, method, route, body) {
  return fetch(api + route, { method, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function request(user, method, route, body) {
  const r = await response(user, method, route, body);
  assert.ok(r.ok, `${method} ${route.split('?')[0].replace(/[a-f\d]{24}/g, '[id]')} returned ${r.status}`);
  return (await r.json()).data;
}
async function account(suffix, name) {
  const email = `reactions-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: name });
  const user = { email, password, token: auth.accessToken, name };
  await request(user, 'POST', '/friends/join', {});
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function makeFriends(a, b) {
  const invitation = await request(a, 'POST', '/friends/requests', { userId: b.id });
  await request(b, 'POST', `/friends/requests/${invitation.requestId}/accept`, {});
}
async function session(user, space) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(ui + '/login');
  if (space === 'friends') {
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
    await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
    await page.waitForURL('**/friends/login');
  }
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === (space === 'friends' ? '/friends' : '/'), { timeout: 20_000 });
  return { context, page };
}
async function check(name, fn) { await fn(); console.log('PASS', name); }
async function shot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled',
    mask: [page.locator('input, textarea')] });
}
const card = (page, marker) => page.locator('article.post').filter({ hasText: marker });
const sheet = page => page.getByRole('dialog', { name: 'Người đã thả cảm xúc', exact: true });
async function open(page, marker, names, screenshot) {
  const summary = card(page, marker).getByRole('button', { name: 'Xem người đã thả cảm xúc', exact: true });
  await summary.waitFor(); await summary.click();
  const dialog = sheet(page); await dialog.waitFor();
  for (const name of names) await dialog.locator('.reaction-person').filter({ hasText: name }).waitFor();
  if (screenshot) await shot(page, screenshot);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await summary.evaluate(el => document.activeElement === el), true, 'Escape restores focus to summary');
}

try {
  await mkdir(evidence, { recursive: true });
  const a = await account('a', 'Cảm Xúc An'), b = await account('b', 'Cảm Xúc Bình');
  const c = await account('c', 'Cảm Xúc Chi'), stranger = await account('stranger', 'Cảm Xúc Ngoài');
  await makeFriends(a, b); await makeFriends(a, c);
  const invite = await request(a, 'POST', '/pairing/invite', { toEmail: b.email });
  await request(b, 'POST', `/pairing/invites/${invite.id}/accept`, {});
  const darkMarker = `Cảm xúc Dark ${run}`, loveMarker = `Cảm xúc Love ${run}`;
  const dark = await request(a, 'POST', '/friends/stories', { body: darkMarker, photos: [] });
  const love = await request(a, 'POST', '/stories', { body: loveMarker, photos: [] });
  for (const [user, type] of [[a, 'love'], [b, 'haha'], [c, 'wow']])
    await request(user, 'PUT', `/friends/stories/${dark.id}/reaction`, { type });
  await request(a, 'PUT', `/stories/${love.id}/reaction`, { type: 'love' });
  await request(b, 'PUT', `/stories/${love.id}/reaction`, { type: 'haha' });

  await check('Dark endpoint paginates by ID without duplicate or private fields', async () => {
    let cursor; const items = [];
    do {
      const page = await request(b, 'GET', `/friends/stories/${dark.id}/reactions?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      assert.ok(page.items.length <= 1); items.push(...page.items);
      if (page.nextCursor) assert.notEqual(page.nextCursor, cursor, 'cursor advances');
      cursor = page.nextCursor;
    } while (cursor && items.length <= 3);
    assert.equal(cursor, null); assert.equal(items.length, 3);
    assert.deepEqual(items.map(x => x.id), [a.id, b.id, c.id].sort());
    assert.deepEqual(new Set(items.map(x => x.type)), new Set(['love', 'haha', 'wow']));
    for (const item of items) assert.deepEqual(Object.keys(item).sort(), ['avatarUrl', 'displayName', 'id', 'type']);
    assert.equal((await response(stranger, 'GET', `/friends/stories/${dark.id}/reactions`)).status, 404);
    assert.equal((await response(null, 'GET', `/friends/stories/${dark.id}/reactions`)).status, 401);
    assert.equal((await response(b, 'GET', `/friends/stories/${dark.id}/reactions?limit=101`)).status, 400);
    assert.equal((await response(b, 'GET', `/friends/stories/${dark.id}/reactions?cursor=bad`)).status, 400);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'),
    headless: process.env.LW_HEADED !== '1', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const darkSession = await session(b, 'friends'); activePage = darkSession.page;
  const dp = darkSession.page;
  await check('Dark feed, detail and author profile show reactor identities and restore focus', async () => {
    await dp.goto(ui + '/friends'); await open(dp, darkMarker, [a.name, b.name, c.name], 'dark-feed');
    await dp.goto(`${ui}/friends/posts/${dark.id}`); await open(dp, darkMarker, [a.name, b.name, c.name], 'dark-detail');
    await dp.goto(`${ui}/friends/u/${a.id}`); await open(dp, darkMarker, [a.name, b.name, c.name], 'dark-profile');
  });
  await check('Dark sheet shows own marker, emoji and reaction labels', async () => {
    await card(dp, darkMarker).getByRole('button', { name: 'Xem người đã thả cảm xúc', exact: true }).click();
    const dialog = sheet(dp); await dialog.waitFor();
    const own = dialog.locator('.reaction-person').filter({ hasText: b.name });
    await own.waitFor(); assert.match(await own.innerText(), /Bạn/); assert.match(await own.innerText(), /Haha/);
    assert.match(await own.innerText(), /😆/);
    await dp.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  });
  await darkSession.context.close();
  // Home has many authorized reads; keep its startup separate from the previous session's read burst.
  await delay(61_000);
  const loveSession = await session(a, 'couple'); activePage = loveSession.page;
  const lp = loveSession.page;
  await check('Love feed and detail derive at most two reactors', async () => {
    await lp.goto(ui + '/stories'); await open(lp, loveMarker, [a.name, b.name], 'love-feed');
    await lp.goto(`${ui}/stories/${love.id}`); await open(lp, loveMarker, [a.name, b.name], 'love-detail');
    await card(lp, loveMarker).getByRole('button', { name: 'Xem người đã thả cảm xúc', exact: true }).click();
    const dialog = sheet(lp); await dialog.waitFor();
    await dialog.locator('.reaction-person').filter({ hasText: b.name }).waitFor();
    assert.equal(await dialog.locator('.reaction-person').count(), 2);
    assert.match(await dialog.locator('.reaction-person').filter({ hasText: a.name }).innerText(), /Bạn/);
    await lp.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  });
  await loveSession.context.close(); activePage = undefined;
  await check('Bilateral reactor block filters before paging; author block denies story', async () => {
    await request(b, 'POST', '/friends/blocks', { userId: c.id });
    const visible = await request(b, 'GET', `/friends/stories/${dark.id}/reactions?limit=100`);
    assert.deepEqual(visible.items.map(x => x.id).sort(), [a.id, b.id].sort());
    assert.ok(!JSON.stringify(visible).includes(c.id));
    await request(a, 'POST', '/friends/blocks', { userId: b.id });
    assert.equal((await response(b, 'GET', `/friends/stories/${dark.id}/reactions`)).status, 404);
  });
  assert.deepEqual(pageErrors, []);
  console.log('PASS local mock reaction browser suite; screenshots:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input, textarea')] }).catch(() => {});
  const message = String(error?.message || 'Failure').split('\nCall log:')[0]
    .replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  console.error(message); process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
