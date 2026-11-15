// Operator-owned local API4002/UI5175 only. This script never starts/stops servers.
// Moment endpoints/storage below are browser route fixtures: this proves UI behavior, NOT server cutoff/ACL/CAS.
// Synthetic accounts/couple remain in local DB. No HAR, trace, storage state, credentials or real providers saved/used.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw new Error('Explicit --local-mock-runtime opt-in required');
const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `moments-${Date.now()}`);
const run = randomBytes(5).toString('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${png.toString('base64')}`;
const contexts = [], pageErrors = [], gates = new Set();
let browser, activePage;
async function request(user, method, route, body) {
  const res = await fetch(api + route, { method, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(res.ok, `${method} ${route.split('?')[0].replace(/[a-f\d]{24}/g, '[id]')} returned ${res.status}`);
  return (await res.json()).data;
}
async function account(suffix) {
  const email = `moments-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: `Moment ${suffix.toUpperCase()}` });
  return { email, password, token: auth.accessToken };
}
function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const gate = { promise, release: () => { gates.delete(gate); release(); } }; gates.add(gate); return gate;
}
async function eventually(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function check(name, fn) { await fn(); console.log('PASS', name); }
async function shot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false, animations: 'disabled', mask: [page.locator('input, textarea')] });
}
const captureSheet = page => page.getByRole('dialog', { name: 'Khoảnh khắc của bạn', exact: true });

try {
  await mkdir(evidence, { recursive: true });
  const a = await account('a'), b = await account('b');
  const invitation = await request(a, 'POST', '/pairing/invite', { toEmail: b.email });
  await request(b, 'POST', `/pairing/invites/${invitation.id}/accept`, {});
  const me = await request(a, 'GET', '/me');
  const pulseBase = await request(a, 'GET', '/couple/pulse');
  const timezone = me.couple?.timezone || 'Asia/Ho_Chi_Minh';
  let now = Date.now();
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const previousDate = new Date(Date.parse(`${localDate}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const iso = time => new Date(time).toISOString();
  const photo = caption => ({ url: image, width: 1, height: 1, caption, postedAt: iso(now), lateMin: 0 });
  const makeSession = ({ id = randomUUID(), date = localDate, end = now + 3600000, rewardEnd = Math.min(now + 60000, end - 1), state = 'open', mine = null, partner = null, legacy = false, scheduleVersion = legacy ? 1 : 3, storyId = null } = {}) => ({
    localDate: date, sessionId: id, legacy, scheduleVersion, state, promptAt: iso(rewardEnd - (scheduleVersion === 3 ? 1800000 : 600000)), windowEndsAt: iso(rewardEnd), rewardEndsAt: iso(rewardEnd), closesAt: iso(end), closed: scheduleVersion !== 3 || end <= now,
    mine, partner: { posted: !!partner, postedAt: partner?.postedAt ?? null, photo: mine ? partner : null }, storyId,
  });
  const waitingPulse = () => ({ localDate, scheduleVersion: 3, sessionId: null, state: 'waiting', windowEndsAt: null, rewardEndsAt: null, closesAt: null, partnerPosted: false });
  let fixture = { localDate, legacy: false, scheduleVersion: 3, sessions: [] }, historical = [], pulse = waitingPulse();
  let holdPut = null, holdPost = null, postResult = null;
  const calls = { today: 0, upload: [], put: [], post: [], story: [] };
  const setSession = session => {
    fixture = { localDate, legacy: false, scheduleVersion: 3, sessions: session ? [session] : [] };
    pulse = { ...waitingPulse(), sessionId: session?.sessionId ?? null, state: session?.state ?? 'waiting', windowEndsAt: session?.rewardEndsAt ?? null,
      rewardEndsAt: session?.rewardEndsAt ?? null, closesAt: session?.closesAt ?? null, partnerPosted: session?.partner.posted ?? false };
  };
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'),
    headless: process.env.LW_HEADED !== '1', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: timezone,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  contexts.push(context);
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.route(`${ui}/api/couple/pulse`, route => route.fulfill({ json: { data: { ...pulseBase, moment: pulse } } }));
  await page.route(`${ui}/__moment_fixture_upload/**`, async route => {
    assert.equal(route.request().method(), 'PUT'); calls.put.push(route.request().url());
    const gate = holdPut; if (gate) await gate.promise;
    await route.fulfill({ status: 200, body: '' }).catch(() => {});
  });
  await page.route(`${ui}/api/moments**`, async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (method === 'GET' && url.pathname === '/api/moments/today') { calls.today++; await route.fulfill({ json: { data: structuredClone(fixture) } }); return; }
    if (method === 'GET' && url.pathname === '/api/moments') {
      const month = url.searchParams.get('month');
      const days = [...historical, fixture].filter(day => day.localDate.startsWith(month));
      await route.fulfill({ json: { data: { month, today: localDate, minMonth: previousDate.slice(0, 7), days, streak: { current: 1, best: 1 } } } }); return;
    }
    if (method === 'POST' && url.pathname === '/api/moments/upload-url') {
      const body = req.postDataJSON(); calls.upload.push(body);
      const key = `couples/${me.couple.id}/moments/${body.localDate}/${body.sessionId}/${me.user.id}/${randomUUID()}.jpg`;
      await route.fulfill({ json: { data: { imageKey: key, uploadUrl: `${ui}/__moment_fixture_upload/${body.sessionId}`, expiresIn: 600, maxBytes: 5242880 } } }); return;
    }
    if (method === 'POST' && url.pathname === '/api/moments/today') {
      const body = req.postDataJSON(); calls.post.push(body);
      const result = structuredClone(postResult ?? fixture), gate = holdPost;
      if (gate) await gate.promise;
      await route.fulfill({ json: { data: result } }).catch(() => {}); return;
    }
    if (method === 'POST' && url.pathname.endsWith('/story')) {
      calls.story.push({ date: url.pathname.split('/')[3], ...req.postDataJSON() });
      await route.fulfill({ status: 409, json: { error: { code: 'MOMENT_STORY_EXISTS', message: 'Fixture đã có trên Story.' } } }); return;
    }
    throw new Error(`Unexpected fixture moment request: ${method} ${url.pathname}`);
  });
  await page.goto(ui + '/login');
  await page.getByLabel('Email', { exact: true }).fill(a.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(a.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
  assert.ok(page.clock, 'This source requires Playwright clock support (external dependency only)');
  await page.clock.setFixedTime(new Date(now));
  const advance = async ms => { now += ms; await page.clock.setFixedTime(new Date(now)); await page.waitForTimeout(1100); };
  const visit = async pathname => { await page.goto(ui + pathname); await page.locator('h1').first().waitFor(); };
  const cycleNoPinVisibility = async () => {
    const before = await page.evaluate(() => window.__lwAppLock.epoch);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const refreshed = page.waitForResponse(res => new URL(res.url()).pathname === '/api/privacy-lock' && res.request().method() === 'GET');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    const response = await refreshed;
    assert.ok(response.ok(), 'No-PIN visibility resume must revalidate lock settings');
    assert.equal((await response.json()).data.couple, false, 'Synthetic fixture must remain PIN-free');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-app-shield'));
    // The lock shield clears before REST/SSE access revalidation. A concealed sheet
    // during that separate boundary is not a completed upload.
    await page.locator('.verification-screen').waitFor({ state: 'hidden' });
    assert.ok(await page.evaluate(() => window.__lwAppLock.epoch) > before, 'Exercise real bootstrap conceal epoch, not only a synthetic focus event');
  };
  const pick = async ({ visibilityCycle = false } = {}) => {
    // Sets the real capture file input from memory; no OS camera/gallery or disk fixture required.
    const button = page.getByRole('button', { name: /^Chụp (ngay|giữ chuỗi)$/, exact: true }).first();
    await button.waitFor();
    // The component freezes session identity in its button callback before change; dismiss mocked native chooser by setting its files.
    const chooser = page.waitForEvent('filechooser');
    await button.click();
    await chooser; // Playwright intercepts the native picker; do not open a real OS dialog.
    if (visibilityCycle) await cycleNoPinVisibility();
    await page.locator('input[type="file"][aria-label="Chụp ảnh Khoảnh khắc"]').first().setInputFiles({ name: 'moment.png', mimeType: 'image/png', buffer: png });
    await captureSheet(page).waitFor();
    await captureSheet(page).locator('.mo-preview img').waitFor();
  };
  await check('UI fixture: no-PIN native-camera visibility round trip accepts the returned file', async () => {
    const session = makeSession({ end: now + 60000 }); setSession(session); await visit('/moments');
    await pick({ visibilityCycle: true });
    const before = calls.upload.length;
    await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.upload.length > before, 'No-PIN camera return was discarded after conceal/revalidation');
    assert.equal(calls.upload.at(-1).sessionId, session.sessionId);
    await captureSheet(page).waitFor({ state: 'hidden' });
  });
  await check('UI fixture: background during no-PIN upload resumes or settles to retry, never a permanently busy sheet', async () => {
    const session = makeSession({ end: now + 60000 }); setSession(session); holdPut = deferred();
    const beforePut = calls.put.length;
    await visit('/moments'); await pick();
    await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.put.length > beforePut, 'No-PIN upload did not enter delayed PUT');
    await cycleNoPinVisibility(); holdPut.release(); holdPut = null;
    // Either finish the same target or present an enabled retry; cancellation must not leave busy=true forever.
    await eventually(async () => !await captureSheet(page).isVisible() || await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).isEnabled(), 'No-PIN background left capture permanently busy');
    if (await captureSheet(page).isVisible()) {
      await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
      await captureSheet(page).waitFor({ state: 'hidden' });
    }
    assert.equal(calls.upload.at(-1).sessionId, session.sessionId);
    assert.equal(calls.post.at(-1).sessionId, session.sessionId);
    await shot(page, 'no-pin-background-upload-settled');
  });
  await check('UI fixture: Home has no capture CTA outside a live window', async () => {
    setSession(null); await visit('/');
    await page.getByRole('heading', { name: 'Khoảnh khắc đang mở', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Chụp ngay', exact: true }).count(), 0);
    await shot(page, 'home-between-sessions');
  });
  await check('UI fixture: Home reward deadline switches to neutral keep-streak capture without hiding card', async () => {
    setSession(makeSession({ rewardEnd: now + 5000 })); await visit('/');
    await page.getByRole('button', { name: 'Chụp ngay', exact: true }).waitFor();
    await advance(5000);
    await page.getByRole('heading', { name: 'Khoảnh khắc đang mở', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chụp giữ chuỗi', exact: true }).waitFor();
    assert.equal(await page.getByRole('timer').count(), 0);
    await shot(page, 'home-after-reward-deadline');
  });
  await check('UI fixture: preview survives reward deadline and can submit late in the same day', async () => {
    const s = makeSession({ rewardEnd: now + 5000 }); setSession(s); await visit('/moments'); await pick();
    const preview = await captureSheet(page).locator('.mo-preview img').getAttribute('src');
    await advance(5000); await captureSheet(page).waitFor();
    assert.equal(await captureSheet(page).locator('.mo-preview img').getAttribute('src'), preview);
    assert.ok(await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).isEnabled());
    const before = calls.post.length;
    await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.post.length > before, 'Late-day capture did not post');
    assert.equal(calls.post.at(-1).sessionId, s.sessionId); await captureSheet(page).waitFor({ state: 'hidden' });
  });
  await check('UI fixture: delayed storage upload across reward deadline still posts the original same-day target', async () => {
    const s = makeSession({ rewardEnd: now + 5000 }); setSession(s); holdPut = deferred();
    const beforePost = calls.post.length, beforePut = calls.put.length;
    await visit('/moments'); await pick(); await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.put.length > beforePut, 'Upload PUT did not enter fixture');
    await advance(5000); await captureSheet(page).waitFor();
    holdPut.release(); holdPut = null;
    await eventually(() => calls.post.length > beforePost, 'Reward expiry incorrectly blocked posting');
    assert.equal(calls.post.at(-1).sessionId, s.sessionId); await captureSheet(page).waitFor({ state: 'hidden' });
  });
  await check('UI fixture: day-end cutoff hides Home card without waiting for pulse polling', async () => {
    setSession(makeSession({ end: now + 5000 })); await visit('/');
    await page.getByRole('heading', { name: 'Khoảnh khắc đang mở', exact: true }).waitFor();
    await advance(5001);
    await page.getByRole('heading', { name: 'Khoảnh khắc đang mở', exact: true }).waitFor({ state: 'hidden' });
  });
  await check('UI fixture: cutoff closes capture sheet and releases preview; retake/submit disappear', async () => {
    setSession(makeSession({ end: now + 5000 })); await visit('/moments'); await pick();
    await shot(page, 'capture-open'); await advance(5001);
    await captureSheet(page).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.mo-preview img').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Chụp ngay', exact: true }).count(), 0);
    await shot(page, 'capture-expired');
  });
  await check('UI fixture: delayed storage PUT after cutoff never sends post or switches session', async () => {
    const s = makeSession({ end: now + 5000 }); setSession(s); holdPut = deferred();
    const beforePost = calls.post.length, beforePut = calls.put.length;
    await visit('/moments'); await pick(); await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.put.length > beforePut, 'Upload PUT did not enter fixture');
    assert.equal(calls.upload.at(-1).sessionId, s.sessionId); assert.equal(calls.upload.at(-1).localDate, localDate);
    await advance(5001); await captureSheet(page).waitFor({ state: 'hidden' });
    holdPut.release(); holdPut = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(calls.post.length, beforePost);
  });
  await check('UI fixture: delayed old POST cannot update later-session view; requests bind the captured session', async () => {
    const old = makeSession({ end: now + 5000 }); setSession(old); holdPost = deferred();
    postResult = { localDate, legacy: false, scheduleVersion: 3, sessions: [{ ...old, state: 'posted', mine: photo('OLD RESPONSE MUST NOT SHOW') }] };
    const before = calls.post.length;
    await visit('/moments'); await pick(); await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.post.length > before, 'Post did not enter delayed fixture');
    assert.equal(calls.post.at(-1).sessionId, old.sessionId); assert.equal(calls.post.at(-1).localDate, localDate);
    assert.ok(calls.post.at(-1).key.includes(`/${old.sessionId}/${me.user.id}/`));
    await advance(5001); await captureSheet(page).waitFor({ state: 'hidden' });
    const next = makeSession({ end: now + 60000 }); setSession(next);
    const reads = calls.today;
    // Refetch in the SAME mounted document; a reload would merely cancel the old request and prove less.
    await cycleNoPinVisibility();
    await eventually(() => calls.today > reads, 'Foreground revalidation did not refetch moments');
    await page.getByRole('button', { name: 'Chụp ngay', exact: true }).waitFor();
    const urlBefore = page.url(); holdPost.release(); holdPost = null; postResult = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(page.url(), urlBefore); assert.equal(await page.getByText('OLD RESPONSE MUST NOT SHOW', { exact: false }).count(), 0);
    await pick(); const beforeUpload = calls.upload.length;
    await captureSheet(page).getByRole('button', { name: 'Đăng', exact: true }).click();
    await eventually(() => calls.upload.length > beforeUpload, 'Later session did not create its own upload');
    assert.equal(calls.upload.at(-1).sessionId, next.sessionId);
    await captureSheet(page).waitFor({ state: 'hidden' });
    await shot(page, 'later-session-unaffected');
  });
  await check('UI fixture: calendar groups multiple sessions, locks different-session partner, and legacy remains read-only', async () => {
    const paired = makeSession({ end: now - 3600000, scheduleVersion: 2, state: 'both', mine: photo('paired mine'), partner: photo('paired partner'), storyId: '000000000000000000000124' });
    const locked = makeSession({ end: now - 1800000, scheduleVersion: 2, state: 'missed', partner: photo('HIDDEN DIFFERENT SESSION') });
    const mineOnly = makeSession({ end: now - 600000, scheduleVersion: 2, state: 'posted', mine: photo('later mine') });
    fixture = { localDate, legacy: false, scheduleVersion: 2, sessions: [paired, locked, mineOnly] }; pulse = waitingPulse();
    const legacy = makeSession({ date: previousDate, id: 'legacy', end: now - 86400000, state: 'both', legacy: true,
      mine: { ...photo('legacy mine'), lateMin: 25 }, partner: photo('legacy partner'), storyId: '000000000000000000000123' });
    historical = [{ localDate: previousDate, legacy: true, scheduleVersion: 1, sessions: [legacy] }];
    await visit('/moments');
    await page.getByRole('button', { name: new RegExp(`^Ngày ${Number(localDate.slice(8))}:`) }).click();
    const history = page.getByRole('dialog').filter({ has: page.locator('.mo-today') }); await history.waitFor();
    assert.equal(await history.locator('.mo-today').count(), 3);
    assert.equal(await history.getByRole('button', { name: 'Đăng khoảnh khắc lên Story', exact: true }).count(), 0);
    await history.getByRole('link', { name: 'Xem trên Story', exact: true }).waitFor();
    assert.equal(await history.getByRole('button', { name: /^Chụp (ngay|giữ chuỗi)$/, exact: true }).count(), 0);
    assert.equal(await history.getByText('HIDDEN DIFFERENT SESSION', { exact: false }).count(), 0);
    await shot(page, 'history-three-sessions'); await page.keyboard.press('Escape');
    await visit(`/moments?date=${previousDate}&session=legacy`);
    const legacySheet = page.getByRole('dialog').filter({ hasText: 'Khoảnh khắc cũ' }); await legacySheet.waitFor();
    await legacySheet.getByText('legacy mine', { exact: false }).waitFor();
    assert.equal(await legacySheet.getByRole('button', { name: 'Chụp ngay', exact: true }).count(), 0);
    assert.equal(await legacySheet.getByRole('button', { name: 'Đăng khoảnh khắc lên Story', exact: true }).count(), 0);
    await legacySheet.getByRole('link', { name: 'Xem trên Story', exact: true }).waitFor();
    await shot(page, 'legacy-read-only');
    await visit(`/moments?date=${localDate}&session=${locked.sessionId}`);
    const selected = page.getByRole('dialog').filter({ has: page.locator('.mo-today') }); await selected.waitFor();
    assert.equal(await selected.locator('.mo-today').count(), 1);
    assert.equal(await selected.getByText('paired mine', { exact: false }).count(), 0);
  });
  assert.deepEqual(pageErrors, []);
  console.log('PASS local moment UI fixture browser suite; screenshots:', evidence);
  console.log('LIMITS: moment/storage routes intercepted; no backend cutoff/ACL/CAS proof, native camera, OS notification, real push or physical-device verification. Synthetic accounts remain in local DB.');
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input, textarea')] }).catch(() => {});
  const message = String(error?.message || 'Failure').split('\nCall log:')[0].replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]')
    .replace(/Bearer\s+\S+/gi, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  console.error(message); process.exitCode = 1;
} finally {
  for (const gate of gates) gate.release();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
