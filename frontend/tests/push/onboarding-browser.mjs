// Operator-owned production preview only; no server lifecycle or real provider/DB.
// node frontend/tests/push/onboarding-browser.mjs --validate
// LW_UI_URL=http://localhost:5175 node frontend/tests/push/onboarding-browser.mjs --local-mock-runtime
// Playwright/Chromium are supplied externally as in frontend/tests/push/browser.mjs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length === 3 && process.argv[2] === '--validate') {
  console.log('Valid arguments: --local-mock-runtime; external Playwright and an operator-owned production preview on loopback port 5175 are required.');
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw new Error('Explicit --local-mock-runtime opt-in required');
const UI = new URL(process.env.LW_UI_URL || 'http://localhost:5175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(UI.hostname) && UI.port === '5175', 'Preview must use loopback port 5175');
assert(['http:', 'https:'].includes(UI.protocol) && !UI.username && !UI.password && !UI.search && !UI.hash && UI.pathname === '/', 'Preview must be a credential-free origin');
const tooling = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const evidence = path.join(os.tmpdir(), 'lw_push_onboarding_browser', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const endpoint = 'https://push-fixture.invalid/subscription';
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const userId = '000000000000000000000001';
const token = 'synthetic-onboarding-access', refreshToken = 'synthetic-onboarding-refresh';
const checks = [], errors = [], scenarios = [], contexts = [];
const limits = ['Synthetic API and browser push APIs only; no real provider, database, native permission, service worker or delivery.', 'Negative UI assertions are bounded observations, not proof of indefinitely suppressed behavior.'];
let browser, activePage, currentStep = 'setup', releaseStreams;
const streamsClosed = new Promise(resolve => { releaseStreams = resolve; });
function safe(error) {
  return String(error?.message || error).split('\nCall log:')[0]
    .replaceAll(token, '[redacted]').replaceAll(refreshToken, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]');
}
async function check(name, fn) { currentStep = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function eventually(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 40)); }
}
const card = page => page.getByRole('complementary', { name: 'Thiết lập thông báo sau đăng nhập' });
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflows horizontally');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input:not([type="checkbox"]), textarea')] });
}
async function quiet(page) { await page.waitForTimeout(900); }
async function zeroEnrollment(page, f) {
  const stats = await page.evaluate(() => window.__pushFixture.stats());
  assert.equal(stats.permissionCalls, 0, 'Unexpected permission request');
  assert.equal(stats.subscribeCalls, 0, 'Unexpected browser subscribe');
  assert.equal(f.posts, 0, 'Unexpected server enrollment');
  assert.equal(stats.notificationCalls, 0, 'Unexpected notification display');
}
async function login(page, mode = 'login') {
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.test');
  if (mode === 'register') {
    await page.getByRole('radio', { name: 'Đăng ký' }).click();
    await page.getByLabel('Tên hiển thị').fill('Fixture User');
  }
  await page.locator(mode === 'register' ? 'input[autocomplete="new-password"]' : 'input[autocomplete="current-password"]').fill('fixture-password');
  await page.getByRole('button', { name: mode === 'register' ? 'Tạo tài khoản' : 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/pairing');
  await page.getByRole('heading', { name: 'Ghép đôi', exact: true }).waitFor();
}
async function makeScenario(label, options = {}) {
  const f = { label, calls: [], posts: 0, deletes: 0, auth: 0 }; scenarios.push(f);
  const mobile = options.ios || options.mobile;
  const context = await browser.newContext({ viewport: mobile ? { width: 360, height: 780 } : { width: 1280, height: 800 },
    isMobile: !!mobile, hasTouch: !!mobile, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block',
    ...(options.ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } : {}) });
  contexts.push(context);
  await context.addInitScript(({ origin, permission, owned, endpoint, userId }) => {
    if (location.origin !== origin) return;
    const key = '__lw_onboarding_fixture';
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, JSON.stringify({ permission, subscribed: owned, permissionCalls: 0, subscribeCalls: 0, unsubscribeCalls: 0, registrationCalls: 0, notificationCalls: 0 }));
      if (owned) localStorage.setItem('lw.push.device', JSON.stringify({ userId, endpoint, version: 2, syncedAt: Date.now() }));
    }
    const read = () => JSON.parse(sessionStorage.getItem(key));
    const mutate = fn => { const state = read(); fn(state); sessionStorage.setItem(key, JSON.stringify(state)); };
    const subscription = { endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'synthetic-key', auth: 'synthetic-key' } }),
      unsubscribe: async () => { mutate(s => { s.unsubscribeCalls++; s.subscribed = false; }); return true; } };
    class FakeNotification {
      constructor() { mutate(s => s.notificationCalls++); throw new Error('Notification display forbidden'); }
      static get permission() { return read().permission; }
      static async requestPermission() { mutate(s => { s.permissionCalls++; s.permission = 'granted'; }); return 'granted'; }
    }
    class FakePushManager {
      async getSubscription() { return read().subscribed ? subscription : null; }
      async subscribe() { mutate(s => { s.subscribeCalls++; s.subscribed = true; }); return subscription; }
      async permissionState() { return read().permission; }
    }
    const registration = { pushManager: new FakePushManager(), scope: `${origin}/`, active: { state: 'activated', postMessage() {} },
      unregister: async () => true, update: async () => registration, addEventListener() {}, removeEventListener() {},
      showNotification: async () => { mutate(s => s.notificationCalls++); throw new Error('Notification display forbidden'); }, getNotifications: async () => [] };
    const sw = new EventTarget();
    Object.assign(sw, { ready: Promise.resolve(registration), controller: registration.active,
      register: async () => { mutate(s => s.registrationCalls++); return registration; }, getRegistration: async () => registration,
      getRegistrations: async () => [registration], startMessages() {} });
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: FakePushManager });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async () => {} });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => {} });
    window.__pushFixture = { stats: read };
  }, { origin: UI.origin, permission: options.permission || 'default', owned: !!options.owned, endpoint, userId });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin !== UI.origin) { errors.push('Blocked external request'); return route.abort('blockedbyclient'); }
    if (p !== '/api' && !p.startsWith('/api/')) {
      if (request.resourceType() === 'document' || /^(\/assets\/|\/icons\/|\/icon\.svg$|\/favicon|\/manifest|\/app-lock-bootstrap\.(js|css)$|\/sw\.js$)/.test(p)) return route.continue();
      errors.push(`Unexpected static request ${p}`); return route.abort('blockedbyclient');
    }
    f.calls.push(`${method} ${p}`);
    const send = data => route.fulfill({ status: 200, json: { data } });
    try {
      if (method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(p)) {
        assert(!request.headers().authorization, 'Auth must be explicit and unauthenticated');
        const body = request.postDataJSON(); assert.equal(body.email, 'fixture@example.test'); assert.equal(body.password, 'fixture-password');
        if (p.endsWith('/register')) assert.equal(body.displayName, 'Fixture User');
        f.auth++; return send({ accessToken: token, refreshToken });
      }
      assert.equal(request.headers().authorization, `Bearer ${token}`, `Unexpected fixture authentication on ${p}`);
      if (method === 'GET' && p === '/api/realtime') { await streamsClosed; return route.fulfill({ contentType: 'text/event-stream', body: ': fixture closed\n\n' }).catch(() => {}); }
      if (method === 'GET' && p === '/api/me') return send({ user: { id: userId, displayName: 'Fixture User', email: 'fixture@example.test', avatarUrl: null, coupleId: null, timezone: 'Asia/Ho_Chi_Minh' }, wallet: { ownerUserId: userId, coinBalance: 0, exp: 0, level: 1, levelBaseExp: 0, nextLevelExp: 100 }, couple: null, level: 1, exp: 0 });
      if (method === 'GET' && p === '/api/privacy-lock') return send({ couple: false, friends: false, revision: 0 });
      if (method === 'GET' && p === '/api/pairing/invites') return send([]);
      if (method === 'GET' && p === '/api/push/config') return send({ enabled: true, publicKey });
      if (method === 'POST' && p === '/api/push/subscriptions') {
        const body = request.postDataJSON(); assert.equal(body.endpoint, endpoint); assert.equal(typeof body.keys?.p256dh, 'string'); assert.equal(typeof body.keys?.auth, 'string'); assert(!Object.hasOwn(body, 'space')); f.posts++; return send({ device: 'synthetic' });
      }
      if (method === 'DELETE' && p === '/api/push/subscriptions') { assert.equal(request.postDataJSON().endpoint, endpoint); f.deletes++; return send({ removed: true }); }
      throw new Error(`Unmocked API request ${method} ${p}`);
    } catch (error) { errors.push(safe(error)); return route.fulfill({ status: 501, json: { error: { code: 'UNMOCKED_FIXTURE', message: 'Unexpected fixture request' } } }); }
  });
  const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(`pageerror ${safe(error)}`));
  page.on('console', message => { if (message.type() === 'error') errors.push('browser console error'); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`requestfailed ${new URL(request.url()).pathname}`); });
  await page.goto(UI.origin + '/login');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('lw.accessToken')), null, 'Fixture must not bootstrap auth');
  return { page, f };
}
try {
  await mkdir(evidence, { recursive: true });
  const { chromium } = createRequire(path.join(tooling, 'package.json'))('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  browser = await chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1', args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  await check('Login default shows card and enabling requires a tap', async () => {
    const { page, f } = await makeScenario('default-enable', { mobile: true });
    await zeroEnrollment(page, f); await login(page); await card(page).waitFor(); await zeroEnrollment(page, f);
    await card(page).getByText('Bật thông báo trên máy này?', { exact: true }).waitFor(); await shot(page, 'default-card');
    await card(page).getByRole('button', { name: 'Bật thông báo', exact: true }).click();
    await eventually(() => f.posts === 1, 'Enrollment was not posted after tap'); await card(page).waitFor({ state: 'hidden' });
    const stats = await page.evaluate(() => window.__pushFixture.stats());
    assert.equal(stats.permissionCalls, 1); assert.equal(stats.subscribeCalls, 1); assert.equal(stats.notificationCalls, 0); assert.equal(f.auth, 1);
  });
  await check('Later suppresses route changes, focus and explicit relogin', async () => {
    const { page, f } = await makeScenario('later'); await login(page); await card(page).waitFor(); await zeroEnrollment(page, f);
    await card(page).locator('button.btn-secondary').filter({ hasText: /^Để sau$/ }).click(); await card(page).waitFor({ state: 'hidden' });
    await page.evaluate(() => { history.pushState(null, '', '/install'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForURL(url => url.pathname === '/install');
    await page.evaluate(() => { history.pushState(null, '', '/pairing'); dispatchEvent(new PopStateEvent('popstate')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByRole('heading', { name: 'Ghép đôi', exact: true }).waitFor(); await quiet(page); assert.equal(await card(page).count(), 0); await zeroEnrollment(page, f);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForURL(url => url.pathname === '/login');
    await login(page); await quiet(page); assert.equal(await card(page).count(), 0); await zeroEnrollment(page, f); assert.equal(f.auth, 2); await shot(page, 'later-relogin');
  });
  await check('Denied permission gives help without enrollment', async () => {
    const { page, f } = await makeScenario('denied', { permission: 'denied' }); await login(page); await card(page).waitFor();
    await card(page).getByText('Thông báo đang bị chặn', { exact: true }).waitFor();
    await card(page).getByText('Bấm biểu tượng bên trái thanh địa chỉ → Thông báo → Cho phép, rồi tải lại trang.', { exact: true }).waitFor();
    assert.equal(await card(page).getByRole('button', { name: 'Bật thông báo', exact: true }).count(), 0);
    await zeroEnrollment(page, f); await shot(page, 'denied-help');
    await card(page).getByRole('button', { name: 'Đã hiểu', exact: true }).click(); await card(page).waitFor({ state: 'hidden' }); await zeroEnrollment(page, f);
  });
  await check('Granted without subscription waits for explicit enrollment', async () => {
    const { page, f } = await makeScenario('granted', { permission: 'granted' }); await login(page); await card(page).waitFor(); await zeroEnrollment(page, f); await shot(page, 'granted-no-subscription');
    await card(page).getByRole('button', { name: 'Bật thông báo', exact: true }).click(); await eventually(() => f.posts === 1, 'Granted enrollment missing after tap');
    await card(page).waitFor({ state: 'hidden' }); const stats = await page.evaluate(() => window.__pushFixture.stats());
    assert.equal(stats.permissionCalls, 0); assert.equal(stats.subscribeCalls, 1); assert.equal(stats.notificationCalls, 0);
  });
  await check('Existing owned opt-in does not show card or enroll again', async () => {
    const { page, f } = await makeScenario('owned', { permission: 'granted', owned: true }); await login(page); await quiet(page);
    assert.equal(await card(page).count(), 0); await zeroEnrollment(page, f); await shot(page, 'owned-no-card');
  });
  await check('Register on iOS offers installation without enrollment', async () => {
    const { page, f } = await makeScenario('ios-register', { ios: true }); await login(page, 'register'); await card(page).waitFor();
    await card(page).getByText('Nhận thông báo trên iPhone', { exact: true }).waitFor();
    await card(page).getByRole('link', { name: 'Xem cách cài app' }).waitFor();
    assert.equal(await card(page).getByRole('button', { name: 'Bật thông báo', exact: true }).count(), 0); await zeroEnrollment(page, f); await shot(page, 'ios-install');
    await card(page).getByRole('link', { name: 'Xem cách cài app' }).click(); await page.waitForURL(url => url.pathname === '/install'); await zeroEnrollment(page, f); assert.equal(f.auth, 1);
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, limits, scenarios: scenarios.map(f => ({ label: f.label, auth: f.auth, posts: f.posts, deletes: f.deletes, apiRoutes: [...new Set(f.calls)] })) }, null, 2));
  console.log(`PASS ${checks.length} browser-fixture checks; evidence ${evidence}`);
} catch (error) {
  console.error(`FAIL ${currentStep}: ${safe(error)}\nEvidence: ${evidence}`);
  if (activePage) await shot(activePage, 'failure').catch(() => {});
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, currentStep, diagnostic: safe(error), checks, errors, limits, scenarios: scenarios.map(f => ({ label: f.label, auth: f.auth, posts: f.posts, deletes: f.deletes, apiRoutes: [...new Set(f.calls)] })) }, null, 2));
  process.exitCode = 1;
} finally {
  releaseStreams();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
