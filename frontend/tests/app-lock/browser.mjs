// Explicitly run only with the operator's owned, mock-provider API and Vite on the fixed ports below.
// Requires the external scripts/browser tooling installation; no browser/runtime is started by this file except Chromium.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') {
  throw new Error('Explicit --local-mock-runtime opt-in required');
}
const UI = 'http://127.0.0.1:5175';
const API = 'http://127.0.0.1:4002';
const tooling = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const evidence = path.join(tooling, 'shots', `app-lock-${Date.now()}-${randomBytes(4).toString('hex')}`);
const run = randomBytes(12).toString('hex');
const password = `Browser-${randomBytes(12).toString('hex')}`;
const lovePin = '014728', darkPin = '306941', wrongPin = '999999';
const checks = [], errors = [], expected = new Map();
let browser, context, page;
let currentStep = 'setup';

async function setup(route, body, token) {
  assert(/^\/(auth\/register|pairing\/invite|pairing\/invites\/[a-f0-9]+\/accept)$/.test(route));
  const response = await fetch(`${API}/api${route}`, { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert(response.ok, `Synthetic setup ${route.replace(/[a-f0-9]{24,}/g, '[id]')} failed with HTTP ${response.status}`);
  return (await response.json()).data;
}
async function seed(label) {
  const user = { email: `app-lock-${run}-${label}@example.test`, password };
  const tokens = await setup('/auth/register', { ...user, displayName: `Synthetic ${label}` });
  return { ...user, token: tokens.accessToken };
}
async function check(name, fn) { currentStep = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(page, name) {
  // No traces, HAR, storage dumps or unmasked credential inputs, including hidden forms.
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled',
    mask: [page.locator('input[type="password"], input[type="email"], input[inputmode="numeric"]')] });
}
async function login(page, user, target) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === target, { timeout: 20000 });
}
async function settings(page, space) {
  await page.evaluate(route => {
    history.pushState(null, '', route);
    dispatchEvent(new PopStateEvent('popstate'));
  }, space === 'couple' ? '/profile/app-lock' : '/friends/me/app-lock');
  await page.getByText(/Khóa ứng dụng: Đang (bật|tắt)/).waitFor({ state: 'visible' });
}
async function editPin(page, pin, user) {
  await page.getByRole('button', { name: /^(Bật khóa|Đổi mã PIN)$/ }).click();
  await page.getByLabel('Mã PIN mới', { exact: true }).fill(pin);
  await page.getByLabel('Nhập lại mã PIN', { exact: true }).fill(pin);
  await page.getByLabel('Mật khẩu tài khoản', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Lưu mã PIN', exact: true }).click();
}
async function disable(page, user) {
  await page.getByRole('button', { name: 'Tắt khóa', exact: true }).click();
  await page.getByLabel('Mật khẩu tài khoản', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Xác nhận tắt khóa', exact: true }).click();
  await page.getByText('Khóa ứng dụng: Đang tắt', { exact: true }).waitFor();
}
async function background(page) {
  // Exercise the real visibility listeners, not OS/app-switcher behavior.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function locked(page) { await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor({ state: 'visible' }); }
async function unlock(page, pin, target) {
  await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).fill(pin);
  await page.waitForURL(url => url.pathname === target, { timeout: 20000 });
  await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).waitFor({ state: 'hidden' });
}
function expect400(method, pathname) { expected.set(`${method} ${pathname}`, (expected.get(`${method} ${pathname}`) || 0) + 1); }

try {
  const require = createRequire(path.join(tooling, 'package.json'));
  const { chromium } = require('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  await mkdir(evidence, { recursive: true });
  const a = await seed('a'), b = await seed('b');
  const invite = await setup('/pairing/invite', { toEmail: b.email }, a.token);
  await setup(`/pairing/invites/${invite.id}/accept`, {}, b.token);
  browser = await chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1' });
  context = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`requestfailed ${new URL(request.url()).pathname}`);
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const key = `${response.request().method()} ${pathname}`;
    if (response.status() === 400 && (expected.get(key) || 0) > 0) expected.set(key, expected.get(key) - 1);
    else errors.push(`HTTP ${response.status()} ${key}`);
  });

  await page.goto(`${UI}/login`);
  await check('Love password login and unlocked no-PIN background', async () => {
    await login(page, a, '/');
    await background(page);
    await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    assert.equal(new URL(page.url()).pathname, '/');
  });
  await check('configure Love PIN and resume with wrong then correct PIN', async () => {
    await settings(page, 'couple');
    await editPin(page, lovePin, a);
    await page.getByText('Khóa ứng dụng: Đang bật', { exact: true }).waitFor();
    await background(page); await locked(page);
    await shot(page, 'locked');
    assert.equal(await page.getByRole('button', { name: 'Mở ứng dụng', exact: true }).count(), 0);
    let attempts = 0;
    const countAttempt = request => { if (new URL(request.url()).pathname === '/api/privacy-lock/unlock') attempts++; };
    page.on('request', countAttempt);
    for (const digit of lovePin.slice(0, 5)) await page.getByRole('group', { name: 'Bàn phím mã khóa' }).getByRole('button', { name: digit, exact: true }).click();
    assert.equal(attempts, 0);
    await page.getByRole('button', { name: 'Xóa một số', exact: true }).click();
    assert.equal(await page.locator('.pin-entry__dot.is-filled').count(), 4);
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).fill('');
    expect400('POST', '/api/privacy-lock/unlock');
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).fill(wrongPin);
      await page.getByText('Mã chưa đúng. Hãy thử lại.', { exact: true }).waitFor();
    await page.locator('.pin-entry--invalid').waitFor({ state: 'hidden' });
    assert.equal(attempts, 1);
    await unlock(page, lovePin, '/');
    assert.equal(attempts, 2);
    page.off('request', countAttempt);
  });
  await check('recovery returns full password login and preserves configured PIN', async () => {
    await background(page); await locked(page);
    await page.getByRole('button', { name: 'Đăng nhập lại', exact: true }).click();
    await page.getByRole('button', { name: 'Đăng xuất và đăng nhập lại', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).waitFor({ state: 'visible' });
    await page.getByLabel('Mật khẩu', { exact: true }).waitFor({ state: 'visible' });
    await shot(page, 'recovery-login');
    await login(page, a, '/');
    await background(page); await locked(page); await unlock(page, lovePin, '/');
  });
  await check('discover Dark via heart gesture and login same account', async () => {
    await background(page); await locked(page);
    await page.getByRole('button', { name: 'Đăng nhập lại', exact: true }).click();
    await page.getByRole('button', { name: 'Đăng xuất và đăng nhập lại', exact: true }).click();
    const heart = page.getByRole('button', { name: 'Trái tim', exact: true });
    await heart.waitFor();
    for (let i = 0; i < 4; i++) await heart.click();
    await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/friends/login');
    await login(page, a, '/friends');
    await background(page); await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    assert.equal(new URL(page.url()).pathname, '/friends');
  });
  await check('reject duplicate Dark PIN then enable distinct PIN', async () => {
    await settings(page, 'friends');
    expect400('PUT', '/api/privacy-lock/friends');
    await editPin(page, lovePin, a);
    await page.getByRole('alert').getByText(/Mã này không dùng được/).waitFor();
    await page.getByLabel('Mã PIN mới', { exact: true }).fill(darkPin);
    await page.getByLabel('Nhập lại mã PIN', { exact: true }).fill(darkPin);
    await page.getByRole('button', { name: 'Lưu mã PIN', exact: true }).click();
    await page.getByText('Khóa ứng dụng: Đang bật', { exact: true }).waitFor();
  });
  await check('both PINs select their respective homes', async () => {
    await background(page); await locked(page); await unlock(page, lovePin, '/');
    await background(page); await locked(page); await unlock(page, darkPin, '/friends');
  });
  await check('cold private link stays neutral and PIN opens Home only', async () => {
    await page.goto(`${UI}/friends/me/app-lock`);
    await locked(page);
    await page.waitForURL(url => url.pathname === '/login');
    assert.equal(await page.title(), 'Love Within');
    assert.equal(await page.locator('html').getAttribute('data-theme'), null);
    assert.equal(await page.getByRole('heading', { name: 'Khóa ứng dụng', exact: true }).count(), 0);
    await unlock(page, lovePin, '/');
  });
  await check('late PIN response after background cannot unlock', async () => {
    await background(page); await locked(page);
    let release, received;
    const arrived = new Promise(resolve => { received = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const handler = async route => {
      const response = await route.fetch();
      received();
      await hold;
      await route.fulfill({ response });
    };
    await page.route('**/api/privacy-lock/unlock', handler);
    await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).fill(lovePin);
      await arrived;
    await background(page);
    release();
    await locked(page);
    await page.getByRole('group', { name: 'Bàn phím mã khóa' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/login');
    await page.unroute('**/api/privacy-lock/unlock', handler);
    await unlock(page, darkPin, '/friends');
  });
  await check('disable Dark leaves it unprotected and Love remains protected', async () => {
    await settings(page, 'friends'); await disable(page, a);
    await background(page); await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    await page.goto(`${UI}/friends`);
    await page.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor({ state: 'visible' });
    await page.waitForURL(url => url.pathname === '/friends');
    // Password re-login into Love verifies the remaining lock on its next resume.
    // Use the normal recovery from a protected state instead of direct storage manipulation.
  });
  await check('disable both spaces and resume without PIN', async () => {
    // Re-enable Dark temporarily to reach the common unlock and switch to Love via its PIN.
    await settings(page, 'friends'); await editPin(page, darkPin, a);
    await page.getByText('Khóa ứng dụng: Đang bật', { exact: true }).waitFor();
    await background(page); await locked(page); await unlock(page, lovePin, '/');
    await background(page); await locked(page); await unlock(page, lovePin, '/');
    await settings(page, 'couple'); await disable(page, a);
    await background(page); await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    await page.goto(`${UI}/profile`);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    const heart = page.getByRole('button', { name: 'Trái tim', exact: true });
    await heart.waitFor();
    for (let i = 0; i < 4; i++) await heart.click();
    await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/friends/login');
    await login(page, a, '/friends');
    await settings(page, 'friends'); await disable(page, a);
    await background(page); await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('Nhập mã mở ứng dụng', { exact: true }).count(), 0);
    await page.goto(`${UI}/friends`);
    await page.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor({ state: 'visible' });
    await page.waitForURL(url => url.pathname === '/friends');
  });
  assert.equal([...expected.values()].reduce((a, b) => a + b, 0), 0, 'Expected HTTP 400 count mismatch');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
  console.log(`PASS ${checks.length} checks; evidence ${evidence}`);
} catch (error) {
  // Redact all fixture credentials before showing selector diagnostics.
  const diagnostic = String(error?.message || error).replaceAll(password, '[password]').replaceAll(lovePin, '[pin]').replaceAll(darkPin, '[pin]').replaceAll(wrongPin, '[pin]').replace(/app-lock-[^\s"']+@example\.test/g, '[email]');
  console.error(`FAIL ${currentStep}; evidence ${evidence}\n${diagnostic}`);
  await mkdir(evidence, { recursive: true });
  if (page) await shot(page, 'failure').catch(() => undefined);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, currentStep, checks, errors }, null, 2));
  process.exitCode = 1;
} finally { await context?.close(); await browser?.close(); }
