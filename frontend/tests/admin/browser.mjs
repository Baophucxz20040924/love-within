// Mock-only mobile admin/recovery evidence. An owned production preview must already be running.
// LW_UI_URL=http://localhost:5175 node frontend/tests/admin/browser.mjs --local-mock-runtime
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
const evidence = path.join(os.tmpdir(), 'lw_admin_browser', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const checks = [], errors = [], contexts = [];
const limits = ['All requests and accounts are synthetic. This verifies frontend behavior only, not backend ACL/CAS or real devices.', 'No storage-state, HAR, tracing, real credentials, providers or production are used. Secret and input screenshots are masked.'];
const fixtureValues = {
  adminToken: 'synthetic-admin-access', accountToken: 'synthetic-account-access', refreshToken: 'synthetic-account-refresh',
  grant: 'synthetic-limited-grant', adminPassword: 'synthetic-admin-password', temporary: 'synthetic-temporary-password', newPassword: 'synthetic-new-password',
};
const uid = '000000000000000000000001';
const userEmail = 'recovery@example.test';
function diagnostic(error) {
  let text = String(error?.message || error).split('\nCall log:')[0];
  for (const value of Object.values(fixtureValues)) text = text.replaceAll(value, '[synthetic credential]');
  return text.replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]');
}
let browser, activePage, currentStep = 'setup', releaseStreams;
const streamsClosed = new Promise(resolve => { releaseStreams = resolve; });
async function check(name, fn) { currentStep = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflows horizontally');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled',
    mask: [page.locator('input:not([type="checkbox"]), textarea, output, .admin-secret__value')] });
}
async function noRestrictedStorage(page) {
  assert(await page.evaluate(({ adminToken, grant, temporary, adminPassword, newPassword }) => {
    const serialized = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state, href: location.href });
    return [adminToken, grant, temporary, adminPassword, newPassword].every(secret => !serialized.includes(secret));
  }, fixtureValues), 'Restricted credentials must not enter storage, URL or navigation state');
}
async function fixture({ storedAccount = false, loginMode = 'required', expiryMs = 900_000, personalVerification = false } = {}) {
  let finishHeldMe;
  const heldMe = new Promise(resolve => { finishHeldMe = resolve; });
  const state = { calls: [], adminLogins: 0, lookups: 0, resets: 0, changes: 0, completions: 0, complete: personalVerification, resetFailure: false, version: 3, searchedEmail: null, copyCount: 0, meReads: 0, releaseVerification: finishHeldMe };
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
  contexts.push(context);
  await context.addInitScript(({ origin, storedAccount, accountToken, refreshToken }) => {
    if (location.origin !== origin) return;
    // No clipboard secret leaves browser memory; this stub records a count only.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { window.__fixtureCopyCount = (window.__fixtureCopyCount || 0) + 1; } } });
    if (sessionStorage.getItem('__admin_fixture')) return;
    localStorage.clear();
    if (storedAccount) localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: 'synthetic-account-generation', tokens: { accessToken: accountToken, refreshToken } }));
    sessionStorage.setItem('__admin_fixture', '1');
  }, { origin: UI.origin, storedAccount, ...fixtureValues });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin !== UI.origin) { errors.push(`Blocked external ${request.resourceType()} request`); return route.abort('blockedbyclient'); }
    if (p !== '/api' && !p.startsWith('/api/')) {
      if (request.resourceType() === 'document' || /^(\/assets\/|\/icons\/|\/icon\.svg$|\/favicon|\/manifest|\/app-lock-bootstrap\.(js|css)$|\/sw\.js$)/.test(p)) return route.continue();
      errors.push(`Unexpected static request ${p}`); return route.abort('blockedbyclient');
    }
    state.calls.push(`${method} ${p}`); // Never request bodies/headers/query values.
    const send = data => route.fulfill({ status: 200, json: { data } });
    const fail = (status, code, message) => route.fulfill({ status, json: { error: { code, message } } });
    try {
      if (p.startsWith('/api/admin/')) {
        if (p === '/api/admin/login' && method === 'POST') {
          assert.equal(request.headers().authorization, undefined);
          const body = request.postDataJSON();
          assert.equal(body.email, 'admin@phucxz.com'); state.adminLogins++;
          if (body.password !== fixtureValues.adminPassword) return fail(401, 'UNAUTHORIZED', 'Email hoặc mật khẩu không đúng.');
          return send({ adminToken: fixtureValues.adminToken, expiresAt: new Date(Date.now() + 900_000).toISOString() });
        }
        assert.equal(request.headers().authorization, `Bearer ${fixtureValues.adminToken}`);
        if (p === '/api/admin/users' && method === 'GET') {
          state.lookups++; state.searchedEmail = url.searchParams.get('email');
          return send({ user: state.searchedEmail === userEmail ? { id: uid, displayName: 'Người dùng thử', email: userEmail, credentialVersion: state.version, mustChangePassword: state.resets > 0, temporaryPasswordExpiresAt: state.resets > 0 ? new Date(Date.now() + 86_400_000).toISOString() : null } : null });
        }
        if (p === `/api/admin/users/${uid}/reset-password` && method === 'POST') {
          const body = request.postDataJSON();
          assert.equal(body.expectedCredentialVersion, state.version); assert.equal(body.currentAdminPassword, fixtureValues.adminPassword);
          state.resets++; state.version++;
          if (state.resetFailure) return fail(503, 'RESPONSE_LOST', 'Synthetic response unavailable after commit');
          return send({ temporaryPassword: fixtureValues.temporary, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), credentialVersion: state.version });
        }
        if (p === '/api/admin/change-password' && method === 'POST') {
          const body = request.postDataJSON(); assert.equal(body.currentPassword, fixtureValues.adminPassword); assert.equal(body.newPassword, fixtureValues.newPassword); assert.equal(body.confirmPassword, fixtureValues.newPassword);
          state.changes++; return send({ changed: true });
        }
      }
      if (p === '/api/auth/login' && method === 'POST') {
        assert.equal(request.headers().authorization, undefined);
        const body = request.postDataJSON(); assert.equal(body.email, userEmail);
        if (loginMode === 'wrong' || body.password !== fixtureValues.temporary) return fail(401, 'UNAUTHORIZED', 'Email hoặc mật khẩu không đúng.');
        return send({ status: 'password_change_required', passwordChangeToken: fixtureValues.grant, expiresAt: new Date(Date.now() + expiryMs).toISOString() });
      }
      if (p === '/api/auth/password-change' && method === 'POST') {
        assert.equal(request.headers().authorization, undefined);
        const body = request.postDataJSON(); assert.equal(body.passwordChangeToken, fixtureValues.grant); assert.equal(body.newPassword, fixtureValues.newPassword); assert.equal(body.confirmPassword, fixtureValues.newPassword);
        state.completions++; state.complete = true;
        return send({ accessToken: fixtureValues.accountToken, refreshToken: fixtureValues.refreshToken });
      }
      assert(state.complete, `Personal endpoint before completed password change: ${p}`);
      assert.equal(request.headers().authorization, `Bearer ${fixtureValues.accountToken}`);
      if (p === '/api/me' && method === 'GET') {
        state.meReads++;
        if (personalVerification && state.meReads > 1) await heldMe;
        return send({ user: { id: uid, displayName: 'Người dùng thử', email: userEmail, avatarUrl: null, coupleId: null, timezone: 'Asia/Ho_Chi_Minh' }, couple: null, wallet: null, level: 1, exp: 0 });
      }
      if (p === '/api/privacy-lock' && method === 'GET') return send({ couple: !personalVerification, friends: true, revision: 4 });
      if (p === '/api/pairing/invites' && method === 'GET') return send([]);
      if (p === '/api/push/config' && method === 'GET') return send({ enabled: false, publicKey: null });
      if (p === '/api/realtime' && method === 'GET') { await streamsClosed; return route.fulfill({ contentType: 'text/event-stream', body: ': fixture closed\n\n' }).catch(() => {}); }
      throw new Error(`Unmocked API request ${method} ${p}`);
    } catch (error) { errors.push(diagnostic(error)); return fail(501, 'UNMOCKED_FIXTURE', 'Unexpected fixture request'); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(`pageerror ${diagnostic(error)}`));
  activePage = page;
  return { page, state };
}
async function adminLogin(page) {
  await page.goto(UI.origin + '/admin/login');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(fixtureValues.adminPassword);
  await page.getByRole('button', { name: 'Đăng nhập quản trị', exact: true }).click();
  await page.getByRole('heading', { name: 'Tìm chính xác tài khoản' }).waitFor();
}
async function lookup(page) {
  await page.getByLabel('Email người dùng').fill(userEmail);
  await page.getByRole('button', { name: 'Tìm tài khoản', exact: true }).click();
  await page.getByRole('heading', { name: 'Người dùng thử', exact: true }).waitFor();
}
async function reset(page) {
  await page.getByRole('checkbox').check();
  await page.getByLabel('Xác nhận mật khẩu admin hiện tại').fill(fixtureValues.adminPassword);
  await page.getByRole('button', { name: 'Xác nhận đặt lại mật khẩu', exact: true }).click();
}
async function temporaryLogin(page) {
  await page.goto(UI.origin + '/login');
  await page.getByLabel('Email', { exact: true }).fill(userEmail);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(fixtureValues.temporary);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
}
try {
  await mkdir(evidence, { recursive: true });
  const { chromium } = createRequire(path.join(tooling, 'package.json'))('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  browser = await chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1', args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  await check('Personal verification teardown releases admin and ignores late personal response', async () => {
    const { page, state } = await fixture({ storedAccount: true, personalVerification: true });
    await page.goto(UI.origin + '/pairing');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-app-mask') === 'verification');
    try {
      await page.evaluate(() => { history.pushState(null, '', '/admin/login'); window.dispatchEvent(new PopStateEvent('popstate')); });
      await page.getByRole('heading', { name: 'Đăng nhập quản trị', exact: true }).waitFor();
      const personalCount = state.calls.filter(call => !call.includes('/api/admin/')).length;
      state.releaseVerification();
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new StorageEvent('storage', { key: 'lw.lockSettingsChanged', newValue: 'synthetic' })); });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-app-mask')), false);
      assert.equal(state.calls.filter(call => !call.includes('/api/admin/')).length, personalCount, 'old personal effects cannot restart inside admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(fixtureValues.adminPassword);
      await page.getByRole('button', { name: 'Đăng nhập quản trị', exact: true }).click();
      await page.getByRole('heading', { name: 'Tìm chính xác tài khoản' }).waitFor();
      await noRestrictedStorage(page); await shot(page, 'admin-after-personal-verification');
    } finally { state.releaseVerification(); }
  });
  await check('Admin isolated from stored personal session; exact lookup, confirm, copy and dismiss', async () => {
    const { page, state } = await fixture({ storedAccount: true });
    await adminLogin(page); await noRestrictedStorage(page);
    await page.evaluate(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'lw.lockSettingsChanged', newValue: 'synthetic' })); document.dispatchEvent(new Event('visibilitychange')); });
    await lookup(page); assert.equal(state.searchedEmail, userEmail); assert.equal(state.lookups, 1);
    assert(await page.getByRole('button', { name: 'Xác nhận đặt lại mật khẩu', exact: true }).isDisabled());
    await shot(page, 'admin-confirm'); await reset(page);
    await page.getByRole('heading', { name: 'Mật khẩu tạm · chỉ hiển thị lần này' }).waitFor();
    assert.equal(state.resets, 1); await noRestrictedStorage(page); await shot(page, 'admin-secret-masked');
    await page.getByRole('button', { name: 'Sao chép mật khẩu' }).click();
    await page.getByText(/Đã sao chép/).waitFor(); assert.equal(await page.evaluate(() => window.__fixtureCopyCount), 1);
    await page.getByRole('button', { name: 'Đã lưu riêng · đóng' }).click();
    assert.equal(await page.locator('.admin-secret__value').count(), 0);
    await page.getByRole('link', { name: 'Đổi mật khẩu admin' }).click();
    await page.getByRole('heading', { name: 'Đổi mật khẩu admin', exact: true }).waitFor();
    await page.getByLabel('Mật khẩu hiện tại').fill(fixtureValues.adminPassword);
    await page.getByLabel('Mật khẩu mới', { exact: true }).fill(fixtureValues.newPassword);
    await page.getByLabel('Xác nhận mật khẩu mới').fill(fixtureValues.newPassword);
    await page.getByRole('button', { name: 'Đổi mật khẩu và đăng xuất' }).click();
    await page.getByRole('heading', { name: 'Đăng nhập quản trị', exact: true }).waitFor();
    assert.equal(state.changes, 1); assert(state.calls.every(call => call.includes('/api/admin/')), 'admin must never request personal endpoints');
    await noRestrictedStorage(page); await shot(page, 'admin-password-changed');
  });
  await check('Reset lost response never retries automatically and requires fresh lookup', async () => {
    const { page, state } = await fixture(); await adminLogin(page); await lookup(page); state.resetFailure = true; await reset(page);
    await page.getByRole('alert').filter({ hasText: 'mật khẩu có thể đã được đặt lại' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Xác nhận đặt lại mật khẩu', exact: true }).count(), 0);
    await page.waitForTimeout(1500); assert.equal(state.resets, 1); await shot(page, 'admin-lost-response');
    await lookup(page); state.resetFailure = false; await reset(page);
    await page.getByRole('heading', { name: 'Mật khẩu tạm · chỉ hiển thị lần này' }).waitFor(); assert.equal(state.resets, 2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw:app-lock', { detail: 'hidden' })));
    await page.getByRole('heading', { name: 'Đăng nhập quản trị', exact: true }).waitFor();
    assert.equal(await page.locator('.admin-secret__value').count(), 0); await noRestrictedStorage(page);
  });
  await check('Admin email restriction, wrong password, reload clears RAM session', async () => {
    const { page, state } = await fixture(); await page.goto(UI.origin + '/admin/login');
    await page.getByLabel('Email quản trị').fill('ordinary@example.test'); await page.getByLabel('Mật khẩu', { exact: true }).fill('synthetic-wrong-password');
    await page.getByRole('button', { name: 'Đăng nhập quản trị', exact: true }).click(); await page.getByRole('alert').waitFor(); assert.equal(state.adminLogins, 0);
    await page.getByLabel('Email quản trị').fill('admin@phucxz.com'); await page.getByRole('button', { name: 'Đăng nhập quản trị', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Email hoặc mật khẩu không đúng.' }).waitFor(); assert.equal(state.adminLogins, 1);
    await adminLogin(page); await page.reload(); await page.getByRole('heading', { name: 'Đăng nhập quản trị', exact: true }).waitFor(); await noRestrictedStorage(page);
  });
  await check('Temporary login requires new password before any personal endpoint or full session', async () => {
    const { page, state } = await fixture(); await temporaryLogin(page); await page.getByRole('heading', { name: 'Đặt mật khẩu mới', exact: true }).waitFor();
    assert.deepEqual(state.calls, ['POST /api/auth/login']); await noRestrictedStorage(page);
    assert(await page.evaluate(() => !localStorage.getItem('lw.accessToken') && !JSON.parse(localStorage.getItem('lw.sessionGeneration') || 'null')?.tokens));
    await shot(page, 'recovery-required');
    await page.getByLabel('Mật khẩu mới', { exact: true }).fill(fixtureValues.newPassword); await page.getByLabel('Xác nhận mật khẩu mới').fill(fixtureValues.newPassword);
    await page.getByRole('button', { name: 'Đổi mật khẩu và tiếp tục' }).click();
    await page.getByRole('heading', { name: 'Ghép đôi', exact: true }).waitFor();
    assert.equal(state.completions, 1); assert(state.calls.indexOf('POST /api/auth/password-change') < state.calls.indexOf('GET /api/me'));
    assert(!state.calls.some(call => call.includes('/friends/join'))); await noRestrictedStorage(page); await shot(page, 'recovery-completed');
  });
  await check('Recovery cannot bypass with navigation or reload', async () => {
    const { page, state } = await fixture(); await temporaryLogin(page); await page.getByRole('heading', { name: 'Đặt mật khẩu mới', exact: true }).waitFor();
    await page.evaluate(() => { history.pushState(null, '', '/pairing'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    assert.equal(state.completions, 0); assert(state.calls.every(call => call === 'POST /api/auth/login'));
    await temporaryLogin(page); await page.getByRole('heading', { name: 'Đặt mật khẩu mới', exact: true }).waitFor(); await page.reload();
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor(); assert.equal(state.completions, 0); await noRestrictedStorage(page);
  });
  await check('Expired recovery grant returns to login without personal effects', async () => {
    const { page, state } = await fixture({ expiryMs: 2500 }); await temporaryLogin(page);
    await page.getByRole('heading', { name: 'Đặt mật khẩu mới', exact: true }).waitFor(); await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    assert.equal(state.completions, 0); assert.deepEqual(state.calls, ['POST /api/auth/login']); await noRestrictedStorage(page); await shot(page, 'recovery-expired');
  });
  await check('Wrong temporary password stays outside recovery and personal app', async () => {
    const { page, state } = await fixture({ loginMode: 'wrong' }); await temporaryLogin(page);
    await page.getByRole('alert').filter({ hasText: 'Email hoặc mật khẩu không đúng.' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Đặt mật khẩu mới', exact: true }).count(), 0); assert.deepEqual(state.calls, ['POST /api/auth/login']);
    await shot(page, 'recovery-wrong-password');
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, limits, viewport: { width: 360, height: 780 } }, null, 2));
  console.log(`PASS ${checks.length} checks; evidence ${evidence}`);
} catch (error) {
  const message = diagnostic(error); console.error(`FAIL ${currentStep}: ${message}\nEvidence: ${evidence}`);
  if (activePage) await shot(activePage, 'failure').catch(() => {});
  await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, currentStep, diagnostic: message, checks, errors, limits }, null, 2)); process.exitCode = 1;
} finally {
  releaseStreams();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
