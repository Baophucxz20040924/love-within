import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const toolingDir = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
export const baseURL = localURL(process.env.LW_UI_URL || 'http://localhost:5173');
export const apiURL = localURL(process.env.LW_API_URL || 'http://localhost:4000');
export const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
export const evidenceDir = process.env.LW_EVIDENCE_DIR || path.join(toolingDir, 'shots', `cp7-${runId}`);
function localURL(value) {
  const url = new URL(value);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Verification only permits local hosts');
  assert(['http:', 'https:'].includes(url.protocol), 'HTTP(S) required');
  return url.origin;
}
export function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/Browser-[a-f0-9]{24}/g, '[redacted-test-password]')
    .replace(/mock[a-f0-9]{28}/g, '[redacted-mock-token]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/((?:token|password|secret|apiKey)["'\s]*[:=]["'\s]*)[^\s,}"']+/gi, '$1[redacted]');
}
// Setup endpoints only. No savings mutation/assertion shortcut is available through this helper.
export async function api(method, route, body, token) {
  assert(/^\/(?:auth\/(?:register|login)|pairing\/(?:invite|invites\/[a-f0-9]+\/accept)|me|finance\/connection(?:\?purge=true)?)$/.test(route), `Not a setup endpoint: ${route}`);
  const response = await fetch(`${apiURL}/api${route}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert(response.ok, `Setup ${method} ${route.split('?')[0]}: HTTP ${response.status} (${result.error?.code || 'unknown'})`);
  return result.data;
}
export async function register(label) {
  const email = `cp7-${label}-${runId}@example.test`;
  const password = `Browser-${randomBytes(12).toString('hex')}`;
  const displayName = label === 'a' ? 'An CP7' : 'Bình CP7';
  const tokens = await api('POST', '/auth/register', { email, password, displayName });
  return { email, password, displayName, token: tokens.accessToken };
}
export async function pair(a, b) {
  const invite = await api('POST', '/pairing/invite', { toEmail: b.email }, a.token);
  return api('POST', `/pairing/invites/${invite.id}/accept`, {}, b.token);
}
export async function newCouple() {
  const a = await register('a'); const b = await register('b');
  await pair(a, b);
  return { a, b };
}
export async function seedBank(user) {
  return api('POST', '/finance/connection', {
    token: `mock${randomBytes(14).toString('hex')}`, accountLast4: '7007',
  }, user.token);
}
export async function cleanupBank(user) { await api('DELETE', '/finance/connection?purge=true', undefined, user.token); }
export async function login(page, user) {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/', { timeout: 20_000 });
}
export async function openBrowser() {
  const require = createRequire(path.join(toolingDir, 'package.json'));
  const { chromium } = require('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  await mkdir(evidenceDir, { recursive: true });
  return chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1' });
}
export async function fresh(browser, label, errors, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(25_000);
  // Do not save traces/HAR/storageState: these can retain tokens or auth request bodies.
  page.on('pageerror', error => errors.push({ label, type: 'pageerror', message: sanitize(error.message) }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    let resourcePath;
    try { resourcePath = new URL(message.location().url).pathname; } catch { /* no resource URL on application errors */ }
    errors.push({ label, type: 'console', message: sanitize(message.text()), ...(resourcePath ? { path: resourcePath } : {}) });
  });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return; // navigation cancellation, not a transport failure
    errors.push({ label, type: 'requestfailed', path: new URL(request.url()).pathname, error: sanitize(request.failure()?.errorText) });
  });
  page.on('response', response => {
    if (response.status() >= 400) errors.push({ label, type: 'http', status: response.status(), path: new URL(response.url()).pathname });
  });
  return { context, page };
}
export async function screenshot(page, name, { animations = 'disabled', fullPage = true } = {}) {
  // Mask credentials only when present; empty inputs behind a modal otherwise hide the modal artwork.
  const credentials = page.locator('input[type="password"], input[type="email"]');
  const mask = [];
  for (let i = 0; i < await credentials.count(); i++) {
    const input = credentials.nth(i);
    if (await input.inputValue()) mask.push(input);
  }
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage, animations, mask });
}
export async function visible(locator) { await locator.waitFor({ state: 'visible' }); }
export async function absent(locator) { await locator.waitFor({ state: 'hidden' }); }
export async function noOverflow(page) {
  const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll('body *')].filter(el => { const box = el.getBoundingClientRect(); return box.width && (box.right > innerWidth + 1 || box.left < -1); }).slice(0, 12).map(el => ({ tag: el.tagName, class: el.className?.baseVal ?? el.className, width: Math.round(el.getBoundingClientRect().width) })) }));
  assert(overflow.scrollWidth <= overflow.width + 1, `Horizontal overflow: ${JSON.stringify(overflow)}`);
}
export async function writeResult(result) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
}
export { assert };
