// Browser-only UI fixtures. The operator supplies an OWNED LOCAL PRODUCTION frontend (not Vite dev).
// Run: LW_UI_URL=http://localhost:5175 node frontend/tests/push/browser.mjs --local-mock-runtime
// External Playwright/Chromium: scripts/browser/README.md. No API, MongoDB, real push or server lifecycle.
// Every /api request is intercepted; unknown API/external requests fail closed. Only local static assets reach a server.
// Evidence contains screenshots, sanitized settings and results in the OS temp directory, never auth/storage/HAR/traces.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw new Error('Explicit --local-mock-runtime opt-in required');
const UI = new URL(process.env.LW_UI_URL || 'http://localhost:5175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(UI.hostname), 'LW_UI_URL must be loopback');
assert(['http:', 'https:'].includes(UI.protocol) && !UI.username && !UI.password && !UI.search && !UI.hash && UI.pathname === '/', 'LW_UI_URL must be a credential-free local origin');
const tooling = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const evidence = path.join(os.tmpdir(), 'lw_push_browser', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const privacyNote = 'Thông báo luôn chỉ hiện “Love Within · Bạn có một thông báo mới”, không hiện tên người, nội dung hay không gian. Chạm để mở app; mã PIN vẫn được yêu cầu nếu bạn đã bật khóa cho không gian đó.';
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'); // Fake; never sent to a provider.
const endpoint = 'https://push-fixture.invalid/subscription';
const checks = [], errors = [], settingsEvidence = [], fixtures = [], contexts = [];
let browser, activePage, currentStep = 'setup', releaseStreams;
const streamsClosed = new Promise(resolve => { releaseStreams = resolve; });
const limits = [
  'UI fixture only: all API responses and browser push APIs are fake; no backend persistence/ACL or real delivery proof.',
  'No physical phone, OS permission prompt, real service worker, push provider, VAPID or notification rendering exercised.',
  'Space selection uses the legacy lw.space preference and reload, then real profile-to-settings links; no general cross-space UI switch exists.',
  'Warm notification-open is a synthetic serviceWorker message; the actual worker notificationclick handler is not executed.',
];
const defaults = space => ({ space, groups: space === 'couple'
  ? { approvals: true, stories: true, reminders: true, nudges: true, moments: true }
  : { social: true, events: true }, preview: false, quiet: { enabled: false, from: '22:00', to: '07:00' } });
function fixture(label, userId, partnerId) {
  const coupleId = '000000000000000000000003';
  const user = { id: userId, displayName: `Synthetic ${label}`, email: `${label.toLowerCase()}@example.test`, avatarUrl: null, coupleId, timezone: 'Asia/Ho_Chi_Minh' };
  const wallet = { ownerUserId: userId, coinBalance: 0, exp: 0, level: 1, levelBaseExp: 0, nextLevelExp: 100 };
  const partner = { id: partnerId, displayName: 'Synthetic partner', email: 'partner@example.test', avatarUrl: null };
  return { label, userId, token: `synthetic-access-${label}`, refreshToken: `synthetic-refresh-${label}`,
    me: { user, wallet, level: 1, exp: 0, couple: { id: coupleId, memberIds: [userId, partnerId], members: [user, partner], anniversaryDate: null,
      daysInLove: 0, nextMilestone: null, lastMilestone: null, level: 1, exp: 0, timezone: 'Asia/Ho_Chi_Minh' } },
    settings: { couple: defaults('couple'), friends: defaults('friends') }, lock: { couple: false, friends: false, revision: 0 },
    calls: [], patches: [], subscribes: 0, deletes: 0, tests: 0, unlocks: 0 };
}
async function eventually(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function check(name, work) { currentStep = name; await work(); checks.push(name); console.log(`PASS ${name}`); }
function safeDiagnostic(error) {
  let message = String(error?.message || error).split('\nCall log:')[0];
  for (const f of fixtures) message = message.replaceAll(f.token, '[token]').replaceAll(f.refreshToken, '[token]');
  return message.replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]');
}
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflows horizontally');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input:not([type="checkbox"]), textarea')] });
}
function deviceSwitch(page) { return page.getByRole('switch', { name: /^Nhận thông báo trên máy này/ }); }
// The decorative track overlays the transparent checkbox. Click its visible native label, not the obscured input.
async function toggle(control) { await control.locator('xpath=ancestor::label').click(); }
function groupSwitch(page, label) { return page.locator('label.list__item').filter({ has: page.locator('.list__label', { hasText: new RegExp(`^${label}$`) }) }).getByRole('switch'); }
async function readySettings(page, space) {
  await page.getByRole('heading', { name: space === 'couple' ? 'Thông báo' : 'Cài đặt thông báo', exact: true }).waitFor();
  await eventually(() => deviceSwitch(page).isEnabled(), 'Push switch unavailable: use a production frontend build with fake browser APIs');
  await page.getByRole('heading', { name: 'Loại thông báo', exact: true }).waitFor();
  await page.locator('.verification-screen').waitFor({ state: 'hidden' });
}
async function assertDevice(page, on) {
  await eventually(async () => await deviceSwitch(page).isEnabled() && await deviceSwitch(page).isChecked() === on, `Expected device switch ${on ? 'on' : 'off'}`);
  await page.getByText(on ? 'Đang bật trên máy này' : 'Đang tắt trên máy này', { exact: true }).waitFor();
}
async function privacy(page) {
  await page.getByText(privacyNote, { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: /Hiện nội dung|preview/i }).count(), 0, 'Privacy must not be an opt-out preview switch');
  assert.equal(await page.getByText('Hiện nội dung', { exact: true }).count(), 0);
}
async function openSettings(page, space) {
  const profilePath = space === 'couple' ? '/profile' : '/friends/me';
  const settingsPath = `${profilePath}/notifications`;
  // Existing app has no authenticated space switch. Select its legacy persisted space, then use the real settings link.
  // Do not touch lw.push.device: reload must preserve and re-read the account's actual UI-created opt-in.
  await page.evaluate(target => {
    if (target === 'friends') localStorage.setItem('lw.space', target);
    else localStorage.removeItem('lw.space');
  }, space);
  await page.goto(UI.origin + profilePath);
  await page.getByRole('heading', { name: space === 'couple' ? 'Hồ sơ' : 'Tôi', exact: true }).waitFor();
  await page.locator(`a[href="${settingsPath}"]`).click();
  await readySettings(page, space);
}
async function captureSettings(f, page, space, checkpoint) {
  await privacy(page);
  const visibleGroups = space === 'couple' ? ['Cần duyệt', 'Kỷ niệm', 'Nhắc sự kiện', 'Nhớ bạn', 'Khoảnh khắc'] : ['Bạn bè', 'Kèo'];
  const groups = {};
  for (const label of visibleGroups) groups[label] = await groupSwitch(page, label).isChecked();
  settingsEvidence.push({ checkpoint, account: f.label, space, deviceOn: await deviceSwitch(page).isChecked(), groups,
    privacyNote: await page.locator('.push-preview').innerText(), settings: structuredClone(f.settings[space]) });
  await shot(page, checkpoint);
}

async function createAccountContext(f, foreignOwner = null) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
  contexts.push(context);
  // Replace APIs BEFORE any app script runs. No call delegates to native Notification, PushManager or serviceWorker.
  await context.addInitScript(({ origin, token, refreshToken, userId, foreignOwner, endpoint }) => {
    if (location.origin !== origin) return;
    const key = '__lw_push_browser_fixture';
    if (!sessionStorage.getItem(key)) {
      localStorage.clear();
      localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: `fixture-${userId}`, tokens: { accessToken: token, refreshToken } }));
      localStorage.setItem('lw.accessToken', token);
      localStorage.setItem('lw.refreshToken', refreshToken);
      sessionStorage.setItem(key, JSON.stringify({ permission: foreignOwner ? 'granted' : 'default', subscribed: !!foreignOwner,
        permissionCalls: 0, subscribeCalls: 0, unsubscribeCalls: 0, registrationCalls: 0, notificationCalls: 0 }));
      if (foreignOwner) localStorage.setItem('lw.push.device', JSON.stringify({ userId: foreignOwner, endpoint, version: 2, syncedAt: Date.now() }));
    }
    const read = () => JSON.parse(sessionStorage.getItem(key));
    const mutate = change => { const state = read(); change(state); sessionStorage.setItem(key, JSON.stringify(state)); return state; };
    const subscription = {
      endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth-key' } }),
      unsubscribe: async () => { mutate(s => { s.unsubscribeCalls++; s.subscribed = false; }); return true; },
    };
    class FakeNotification {
      constructor() { mutate(s => s.notificationCalls++); throw new Error('Unexpected notification rendering; this suite verifies settings only'); }
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
      showNotification: async () => { mutate(s => s.notificationCalls++); throw new Error('No notification display permitted'); }, getNotifications: async () => [] };
    const serviceWorker = new EventTarget();
    Object.assign(serviceWorker, { ready: Promise.resolve(registration), controller: registration.active,
      register: async () => { mutate(s => s.registrationCalls++); return registration; },
      getRegistration: async () => registration, getRegistrations: async () => [registration], startMessages() {} });
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: FakePushManager });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async () => {} });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => {} });
    window.__pushFixture = { stats: read, emit: data => serviceWorker.dispatchEvent(new MessageEvent('message', { data })) };
  }, { origin: UI.origin, token: f.token, refreshToken: f.refreshToken, userId: f.userId, foreignOwner, endpoint });

  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin !== UI.origin) {
      errors.push(`Blocked external ${request.resourceType()} request`);
      return route.abort('blockedbyclient');
    }
    if (p !== '/api' && !p.startsWith('/api/')) {
      if (request.resourceType() === 'document' || /^(\/assets\/|\/icons\/|\/icon\.svg$|\/favicon|\/manifest|\/app-lock-bootstrap\.(js|css)$|\/sw\.js$)/.test(p)) return route.continue();
      errors.push(`Unexpected static request ${p}`);
      return route.abort('blockedbyclient');
    }
    f.calls.push(`${method} ${p}`); // No tokens, request bodies, endpoint URLs or query strings in evidence.
    const send = data => route.fulfill({ status: 200, json: { data } });
    try {
      assert.equal(request.headers().authorization, `Bearer ${f.token}`, `Unexpected fixture authentication on ${p}`);
      if (method === 'GET' && p === '/api/realtime') { await streamsClosed; return route.fulfill({ contentType: 'text/event-stream', body: ': fixture closed\n\n' }).catch(() => {}); }
      if (method === 'GET' && p === '/api/me') return send(f.me);
      if (method === 'GET' && p === '/api/couple') return send(f.me.couple);
      if (method === 'GET' && p === '/api/couple/pulse') return send({ question: null, moment: null, letters: null, nextEvent: null, savings: null });
      if (method === 'GET' && p === '/api/questions/today') return send(null);
      if (method === 'GET' && p === '/api/quests/today') return send([]);
      if (method === 'GET' && p === '/api/checkin') return send({ checkedIn: false, streak: 0 });
      if (method === 'GET' && p === '/api/privacy-lock') return send(f.lock);
      if (method === 'GET' && p === '/api/push/config') return send({ enabled: true, publicKey });
      if (method === 'GET' && p === '/api/push/settings') {
        const space = url.searchParams.get('space'); assert(['couple', 'friends'].includes(space)); return send(f.settings[space]);
      }
      if (method === 'PATCH' && p === '/api/push/settings') {
        const patch = request.postDataJSON(), space = patch.space; assert(['couple', 'friends'].includes(space));
        assert(!Object.hasOwn(patch, 'preview'), 'UI must not mutate preview privacy');
        assert(Object.keys(patch).every(k => ['space', 'groups', 'quiet'].includes(k)), 'Unexpected settings mutation');
        const current = f.settings[space];
        if (patch.groups) assert(Object.keys(patch.groups).every(k => Object.hasOwn(current.groups, k)), 'Group leaked across spaces');
        f.settings[space] = { ...current, groups: { ...current.groups, ...patch.groups }, quiet: { ...current.quiet, ...patch.quiet }, preview: false };
        f.patches.push(structuredClone(patch)); return send(f.settings[space]);
      }
      if (method === 'POST' && p === '/api/push/subscriptions') {
        const body = request.postDataJSON(); assert.equal(body.endpoint, endpoint);
        assert(!Object.hasOwn(body, 'space'), 'Device opt-in must be account-wide, not space-scoped');
        assert.equal(typeof body.keys?.p256dh, 'string'); assert.equal(typeof body.keys?.auth, 'string');
        f.subscribes++; return send({ device: 'synthetic-mobile' });
      }
      if (method === 'DELETE' && p === '/api/push/subscriptions') {
        assert.equal(request.postDataJSON().endpoint, endpoint); f.deletes++; return send({ removed: true });
      }
      if (method === 'POST' && p === '/api/push/test') { f.tests++; return send({ sent: true }); }
      if (method === 'POST' && p === '/api/privacy-lock/unlock') {
        f.unlocks++;
        return send({ space: 'couple', revision: f.lock.revision });
      }
      if (method === 'GET' && ['/api/proposals', '/api/water/pending', '/api/market/redemptions/pending', '/api/ledger'].includes(p)) return send([]);
      if (method === 'GET' && ['/api/stories/unread-count', '/api/market/unread-count'].includes(p)) return send({ count: 0 });
      if (method === 'GET' && p === '/api/wallet') return send(f.me.wallet);
      if (method === 'GET' && p === '/api/water/today') return send({ localDate: '2026-11-16', goalMl: 2000, approvedMl: 0, pendingMl: 0, logs: [], partner: null });
      if (method === 'GET' && p === '/api/finance/connection') return send({ linked: false, status: 'none', visibility: 'private', accountLast4: null, lastError: null, lastSuccessAt: null });
      if (method === 'GET' && p === '/api/friends/unread') return send({ friendRequests: 0, notifications: 0, notificationsSaturated: false });
      if (method === 'GET' && p === `/api/friends/users/${f.userId}`) return send({ user: { ...f.me.user, bio: '' }, friendCount: 0, relationship: 'self', isMe: true });
      if (method === 'GET' && p === '/api/friends') return send({ friends: [], incoming: [], outgoing: [] });
      throw new Error(`Unmocked API request ${method} ${p}`);
    } catch (error) {
      errors.push(safeDiagnostic(error));
      return route.fulfill({ status: 501, json: { error: { code: 'UNMOCKED_FIXTURE', message: 'Unexpected fixture request' } } });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(`pageerror ${safeDiagnostic(error)}`));
  page.on('console', message => { if (message.type() === 'error') errors.push('browser console error'); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`requestfailed ${new URL(request.url()).pathname}`); });
  await page.goto(UI.origin + '/profile');
  return page;
}

try {
  await mkdir(evidence, { recursive: true });
  const { chromium } = createRequire(path.join(tooling, 'package.json'))('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  browser = await chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1',
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const a = fixture('A', '000000000000000000000001', '000000000000000000000002');
  const b = fixture('B', '000000000000000000000002', '000000000000000000000001');
  fixtures.push(a, b);
  const page = await createAccountContext(a); activePage = page;
  await page.locator('a[href="/profile/notifications"]').click();
  await readySettings(page, 'couple');
  await check('A starts off without requesting permission; privacy is fixed', async () => {
    await assertDevice(page, false); await privacy(page);
    assert.equal((await page.evaluate(() => window.__pushFixture.stats())).permissionCalls, 0);
    assert.equal(a.subscribes, 0); await captureSettings(a, page, 'couple', 'a-love-initial-off');
  });
  await check('Enable in Love uses one fake browser subscription and account-wide registration', async () => {
    await toggle(deviceSwitch(page)); await assertDevice(page, true);
    assert.equal(a.subscribes, 1);
    const stats = await page.evaluate(() => window.__pushFixture.stats());
    assert.equal(stats.permissionCalls, 1); assert.equal(stats.subscribeCalls, 1); assert.equal(stats.notificationCalls, 0);
    await toggle(groupSwitch(page, 'Cần duyệt'));
    await eventually(() => a.settings.couple.groups.approvals === false, 'Love group patch not received');
    await captureSettings(a, page, 'couple', 'a-love-on-approvals-off');
  });
  await check('Second account rejects an inherited other-account opt-in', async () => {
    const other = await createAccountContext(b, a.userId); activePage = other;
    await other.locator('a[href="/profile/notifications"]').click(); await readySettings(other, 'couple');
    await assertDevice(other, false);
    await eventually(async () => (await other.evaluate(() => window.__pushFixture.stats())).unsubscribeCalls === 1, 'Foreign subscription was not dropped');
    assert.equal(b.subscribes, 0); assert.equal((await other.evaluate(() => window.__pushFixture.stats())).permissionCalls, 0);
    assert.equal(await other.evaluate(() => localStorage.getItem('lw.push.device')), null);
    assert.equal(await groupSwitch(other, 'Cần duyệt').isChecked(), true, 'A settings must not leak into B');
    await captureSettings(b, other, 'couple', 'b-no-inherited-opt-in');
    await openSettings(other, 'friends'); await assertDevice(other, false);
    await captureSettings(b, other, 'friends', 'b-dark-off');
    activePage = page; await assertDevice(page, true);
  });
  await check('Love to Dark keeps device on; groups stay independent', async () => {
    await openSettings(page, 'friends'); await assertDevice(page, true);
    assert.equal(await groupSwitch(page, 'Bạn bè').isChecked(), true);
    assert.equal(await groupSwitch(page, 'Kèo').isChecked(), true);
    assert.equal(await groupSwitch(page, 'Cần duyệt').count(), 0);
    await toggle(groupSwitch(page, 'Bạn bè'));
    await eventually(() => a.settings.friends.groups.social === false, 'Dark group patch not received');
    assert.equal(a.settings.couple.groups.approvals, false);
    await captureSettings(a, page, 'friends', 'a-dark-on-social-off');
  });
  await check('Back to Love retains device and Love groups without a second opt-in', async () => {
    await openSettings(page, 'couple'); await assertDevice(page, true);
    assert.equal(await groupSwitch(page, 'Cần duyệt').isChecked(), false);
    assert.equal(await groupSwitch(page, 'Kỷ niệm').isChecked(), true);
    assert.equal(await groupSwitch(page, 'Bạn bè').count(), 0);
    const stats = await page.evaluate(() => window.__pushFixture.stats());
    assert.equal(stats.permissionCalls, 1); assert.equal(stats.subscribeCalls, 1); assert.equal(stats.unsubscribeCalls, 0);
    assert.equal(a.subscribes, 1); assert.equal(a.deletes, 0);
    await captureSettings(a, page, 'couple', 'a-love-return-still-on');
  });
  await check('Off in Dark applies to both spaces without changing group preferences', async () => {
    await openSettings(page, 'friends'); await assertDevice(page, true);
    assert.equal(await groupSwitch(page, 'Bạn bè').isChecked(), false);
    await toggle(deviceSwitch(page)); await assertDevice(page, false);
    assert.equal(a.deletes, 1); await captureSettings(a, page, 'friends', 'a-dark-disabled');
    await openSettings(page, 'couple'); await assertDevice(page, false);
    assert.equal(await groupSwitch(page, 'Cần duyệt').isChecked(), false);
    assert.equal(a.settings.friends.groups.social, false);
    assert.equal(await page.evaluate(() => localStorage.getItem('lw.push.device')), null);
    await captureSettings(a, page, 'couple', 'a-love-also-disabled');
  });
  await check('Locked warm notification-open remains neutral behind the PIN shield', async () => {
    await toggle(deviceSwitch(page)); await assertDevice(page, true);
    a.lock = { couple: true, friends: true, revision: 1 };
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor();
    await page.waitForURL(url => url.pathname === '/login');
    const lockReads = a.calls.filter(call => call === 'GET /api/privacy-lock').length;
    await page.evaluate(() => window.__pushFixture.emit({ type: 'lw:notification-open', url: '/friends/me/notifications', space: 'friends' }));
    await eventually(() => a.calls.filter(call => call === 'GET /api/privacy-lock').length > lockReads, 'Warm push did not revalidate the privacy guard');
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor();
    await page.waitForURL(url => url.pathname === '/login');
    assert.equal(await page.title(), 'Love Within');
    assert.equal(await page.locator('html').getAttribute('data-theme'), null);
    assert.equal(await deviceSwitch(page).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Cài đặt thông báo', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('lw.space')), null);
    assert.equal(a.unlocks, 0); await shot(page, 'a-warm-push-still-locked');
  });
  await check('Short protected resume conceals immediately and retains the page without another PIN', async () => {
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).fill('123456');
    await page.waitForURL(url => url.pathname === '/');
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.verification-screen').waitFor({ state: 'hidden' });
    // Route normally without reload so the verified in-memory entry remains the same.
    await page.evaluate(() => { history.pushState(null, '', '/profile'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('heading', { name: 'Hồ sơ', exact: true }).waitFor();
    const before = a.unlocks;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      if (!document.documentElement.hasAttribute('data-app-shield') || document.documentElement.getAttribute('data-app-mask') !== 'lock') throw new Error('Content was not immediately concealed');
    });
    await shot(page, 'short-resume-concealed');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('heading', { name: 'Hồ sơ', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/profile');
    assert.equal(a.unlocks, before);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    await shot(page, 'short-resume-restored');
  });
  await check('Ten-second protected resume requires a PIN', async () => {
    await page.evaluate(() => {
      const now = Date.now;
      let offset = 0;
      Date.now = () => now() + offset;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      offset = 10000;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor();
    await page.waitForURL(url => url.pathname === '/login');
    await shot(page, 'ten-second-resume-pin');
  });
  assert.deepEqual(errors, []);
  assert.equal(a.tests + b.tests, 0, 'Never send a test push even to the mocked provider');
  await writeFile(path.join(evidence, 'settings.json'), JSON.stringify(settingsEvidence, null, 2));
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, limits,
    viewport: { width: 360, height: 780 }, accounts: fixtures.map(f => ({ label: f.label, subscribes: f.subscribes, deletes: f.deletes, patches: f.patches, apiRoutes: [...new Set(f.calls)] })) }, null, 2));
  console.log(`PASS ${checks.length} browser-fixture checks; evidence ${evidence}`);
  console.log(`LIMITS: ${limits.join(' ')}`);
} catch (error) {
  console.error(`FAIL ${currentStep}: ${safeDiagnostic(error)}\nEvidence: ${evidence}`);
  if (activePage) await shot(activePage, 'failure').catch(() => {});
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'settings.json'), JSON.stringify(settingsEvidence, null, 2));
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, currentStep, diagnostic: safeDiagnostic(error), checks, errors, limits }, null, 2));
  process.exitCode = 1;
} finally {
  releaseStreams();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
