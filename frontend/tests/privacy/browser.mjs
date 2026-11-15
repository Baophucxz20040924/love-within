// Local mock API4002/UI5175 only. External Playwright; no secrets, traces or saved sessions.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const ui = 'http://127.0.0.1:5175', api = 'http://127.0.0.1:4002/api';
const evidence = path.join(home, 'shots', `privacy-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const checks = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', e => errors.push({ name: e.name, message: e.message.split('\n')[0] }));
const shot = name => page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, animations: 'disabled', mask: [page.locator('input[type=email],input[type=password]')] });
async function gesture() {
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
  const cover = page.locator('#privacy-entry');
  if (await cover.isVisible() && await cover.locator('button').count()) await cover.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  else await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
}
async function hide() {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#privacy-entry .auth__title').waitFor();
  await page.waitForURL('**/login');
  assert.equal(await page.title(), 'Love Within');
  assert.equal(await page.locator('html').getAttribute('data-theme'), null);
}
try {
  const email = `privacy-${randomBytes(5).toString('hex')}@example.test`, password = randomBytes(18).toString('hex');
  const response = await fetch(api + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, displayName: 'Privacy Test' }) });
  assert.equal(response.status, 201);
  await page.goto(ui + '/login');
  await gesture(); await page.waitForURL('**/friends/login');
  await hide();
  assert.equal(await page.getByLabel('Email', { exact: true }).count(), 0, 'hidden login inaccessible after background');
  await gesture(); await page.waitForURL('**/friends/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL('**/friends');
  await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).waitFor();
  checks.push('hidden login relocks and requires fresh gesture; real friends login succeeds');
  const before = await page.evaluate(() => localStorage.getItem('lw.sessionGeneration'));
  await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).click({ trial: true });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).click();
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 30; c.height = 30; c.getContext('2d').fillRect(0,0,30,30); return c.toDataURL().split(',')[1]; });
  await (await chooser).setFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const dialog = page.getByRole('dialog', { name: 'Tạo bài viết', exact: true });
  await dialog.getByLabel('Nội dung bài viết', { exact: true }).fill('Bản nháp giữ qua lớp che');
  await dialog.locator('img[alt="Ảnh đính kèm bài viết"]').evaluate(img => img.decode());
  const draft = await dialog.elementHandle();
  await hide(); await shot('locked-cover');
  assert.equal(await draft.evaluate(node => node.isConnected), true);
  assert.equal(await page.getByRole('dialog').count(), 0, 'private dialog absent from accessibility tree');
  assert.equal(await draft.evaluate(node => getComputedStyle(node).display === 'none' || !node.getClientRects().length), true, 'private portal must be visually hidden');
  assert.equal(await page.evaluate(() => localStorage.getItem('lw.sessionGeneration')), before);
  await gesture();
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Nội dung bài viết', { exact: true }).inputValue(), 'Bản nháp giữ qua lớp che');
  assert.equal(await dialog.locator('img[alt="Ảnh đính kèm bài viết"]').evaluate(img => img.naturalWidth > 0), true);
  await shot('restored-draft');
  checks.push('retained composer and image survive hidden/resume, neutral URL/theme/title and unchanged session');
  // Let resume REST/SSE reconciliation settle before isolated presentation assertions.
  await page.waitForTimeout(1500);
  // Exercise real access state rendering, with independent lock composition.
  await page.evaluate(async () => { const v = await import(performance.getEntriesByType('resource').map(r => r.name).filter(n => new URL(n).pathname === '/src/features/realtime/verification.tsx').at(-1)); v.setVerification('checking'); });
  await page.getByRole('heading', { name: 'Đang kết nối lại' }).waitFor();
  assert.equal(await draft.evaluate(node => !node.getClientRects().length), true, 'verification must visually hide the private portal');
  await shot('verification-checking');
  await page.evaluate(async () => { const v = await import(performance.getEntriesByType('resource').map(r => r.name).filter(n => new URL(n).pathname === '/src/features/realtime/verification.tsx').at(-1)); v.setVerification('failed', () => v.setVerification('clear')); });
  await page.getByRole('heading', { name: 'Chưa thể kết nối lại' }).waitFor(); await shot('verification-failed');
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click(); await dialog.waitFor();
  await hide();
  await page.evaluate(async () => { const v = await import(performance.getEntriesByType('resource').map(r => r.name).filter(n => new URL(n).pathname === '/src/features/realtime/verification.tsx').at(-1)); v.setVerification('checking'); v.setVerification('clear'); });
  await page.locator('#privacy-entry .auth__title').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  checks.push('new verification checking/failed/retry UI and verification cannot clear hidden lock');
  // Native notification message path; latest wins and must not reveal before gesture.
  await page.evaluate(() => { for (const url of ['/friends/people', '/friends/notifications']) navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'lw:navigate', url } })); });
  await page.waitForURL('**/login'); await gesture(); await page.waitForURL('**/friends/notifications');
  checks.push('latest notification destination is deferred until deliberate entry');
  await page.reload(); await page.locator('#privacy-entry .auth__title').waitFor(); await page.waitForURL('**/login');
  assert.equal(await page.evaluate(() => localStorage.getItem('lw.sessionGeneration')), before);
  await gesture(); await page.waitForURL('**/friends/notifications');
  checks.push('cold reload retains credentials but requires fresh gesture');
  await hide();
  await page.goto(ui + '/j/privacy-test-invalid');
  let previews = 0;
  page.on('request', req => { if (new URL(req.url()).pathname.includes('/invites/') && req.method() === 'GET') previews++; });
  await page.locator('#privacy-entry .auth__title').waitFor(); await page.waitForURL('**/login');
  await page.waitForTimeout(600); assert.equal(previews, 0);
  checks.push('cold invite gate does not start preview before deliberate entry');
  // Relock while already locked, including BFCache restore: the interactive cover must return.
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.locator('#privacy-entry .auth__title').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-privacy-shield'), null);
  await gesture();
  await page.getByRole('heading', { name: 'Link không còn hiệu lực' }).waitFor();
  checks.push('repeated pagehide/BFCache events preserve operable cover; invite preview starts only after gesture');
  // Failed /me at cold startup still has routing and an operable cover; no credential loss.
  await page.route('**/api/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"TEST_OFFLINE","message":"Test connection"}}' }));
  await page.goto(ui + '/friends');
  await page.locator('#privacy-entry .auth__title').waitFor(); await page.waitForURL('**/login');
  await page.waitForTimeout(350);
  await gesture();
  await page.getByText('Chưa kiểm tra được phiên đăng nhập', { exact: true }).waitFor();
  await page.unroute('**/api/me');
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).waitFor();
  checks.push('bootstrap failure is shielded, tokens retained, retry restores session after deliberate entry');
  // Real offline lifecycle uses the same styled access surface, not just a direct store test.
  await context.setOffline(true);
  await page.getByRole('heading', { name: 'Đang kết nối lại' }).waitFor();
  // Screenshot font readiness may wait for network while offline; capture after recovery below.
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).waitFor();
  checks.push('real offline/online access verification recovers without a second login');
  // A successful login response held across backgrounding must not start friends/join.
  const raceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const race = await raceContext.newPage();
  let releaseLogin, arrivedLogin;
  const arrived = new Promise(resolve => { arrivedLogin = resolve; });
  const release = new Promise(resolve => { releaseLogin = resolve; });
  let joins = 0;
  race.on('request', req => { if (new URL(req.url()).pathname === '/api/friends/join') joins++; });
  await race.route('**/api/auth/login', async route => { const response = await route.fetch(); arrivedLogin(); await release; await route.fulfill({ response }); });
  await race.goto(ui + '/login');
  for (let i = 0; i < 4; i++) await race.getByRole('button', { name: 'Trái tim', exact: true }).click();
  await race.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await race.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
  await race.getByLabel('Email', { exact: true }).fill(email);
  await race.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await race.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await arrived;
  await race.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
  releaseLogin();
  await race.locator('#privacy-entry .auth__title').waitFor();
  await race.waitForTimeout(400);
  assert.equal(joins, 0, 'stale login response cannot start a chained join');
  assert.equal(await race.evaluate(() => localStorage.getItem('lw.accessToken')), null, 'abandoned login credentials are not installed');
  await raceContext.close();
  checks.push('late successful authentication stays concealed and cannot chain a friends join');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, scope: 'Local mock API and mobile-emulated Chromium. Lifecycle events simulated; no physical picker, native OS snapshot or real BFCache guarantee.' }, null, 2));
  console.log('PASS', checks.length, 'privacy browser checks; evidence:', evidence);
} catch (e) {
  await shot('failure').catch(() => {});
  const dom = await page.evaluate(() => ({ path: location.pathname, shield: document.documentElement.hasAttribute('data-privacy-shield'), mask: document.documentElement.getAttribute('data-privacy-mask'), children: Array.from(document.body.children).map(n => ({ tag: n.tagName, id: n.id, style: n.getAttribute('style'), inert: n.inert, aria: n.getAttribute('aria-hidden'), verification: n.hasAttribute('data-realtime-verification'), rects: n.getClientRects().length })) }));
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, dom, failure: String(e.message).split('\nCall log:')[0] }, null, 2));
  console.error(String(e.message).split('\nCall log:')[0]); console.log('Evidence:', evidence); process.exitCode = 1;
} finally { await browser.close(); }
