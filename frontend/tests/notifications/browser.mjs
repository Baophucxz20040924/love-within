// All APIs are synthetic. An owned local production frontend must already be running.
// LW_UI_URL=http://localhost:5175 node frontend/tests/notifications/browser.mjs --local-mock-runtime
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
const evidence = path.join(os.tmpdir(), 'lw_notifications_browser', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const checks = [], errors = [], contexts = [];
const limits = ['All sessions, data and APIs are synthetic; this does not prove backend authorization, persistence or real-device behavior.', 'An already running owned local production frontend and external Playwright/Chromium are required.'];
const uid = '000000000000000000000001', partnerId = '000000000000000000000002', coupleId = '000000000000000000000003';
const token = 'synthetic-notifications-access', refreshToken = 'synthetic-notifications-refresh';
const user = { id: uid, displayName: 'Synthetic User', email: 'user@example.test', avatarUrl: null, coupleId, timezone: 'Asia/Ho_Chi_Minh' };
const partner = { id: partnerId, displayName: 'Synthetic Partner', email: 'partner@example.test', avatarUrl: null };
const wallet = { ownerUserId: uid, coinBalance: 0, exp: 0, level: 1, levelBaseExp: 0, nextLevelExp: 100 };
const couple = { id: coupleId, memberIds: [uid, partnerId], members: [user, partner], anniversaryDate: null, daysInLove: 0, nextMilestone: null, lastMilestone: null, level: 1, exp: 0, timezone: 'Asia/Ho_Chi_Minh' };
const date = '2026-11-16', timestamp = '2026-11-16T04:00:00.000Z', oldTimestamp = '2020-01-01T00:00:00.000Z';
const oldWaterId = '000000000000000000000011', savingId = '000000000000000000000012', missingId = '000000000000000000000013';
const oldWater = { id: oldWaterId, userId: partnerId, amountMl: 250, source: 'manual', hasImage: false, status: 'pending', reviewedBy: null, localDate: '2020-01-01', createdAt: oldTimestamp, submitterName: partner.displayName };
const retrySaving = { id: savingId, kind: 'savings_goal', payload: { title: 'Quỹ thử nghiệm', emoji: '🌱', targetVnd: 100000 }, createdBy: partnerId, approvals: [partnerId, uid], status: 'pending', applicationState: 'retryable', createdAt: oldTimestamp, resolvedAt: null };
const row = (id, type, target, createdAt = timestamp) => ({ id, type, actorId: partnerId, entityId: target?.id ?? null, target, read: false, createdAt });
const first = [row('n1', 'moment_posted', { kind: 'moment', dayId: 'day-1', localDate: date, sessionId: 'session-1' }), row('n2', 'couple_story', { kind: 'story', id: missingId })];
const second = [row('n3', 'proposal_created', { kind: 'approval', category: 'proposal', id: savingId }, oldTimestamp)];
function diagnostic(error) { return String(error?.message || error).split('\nCall log:')[0].replaceAll(token, '[token]').replaceAll(refreshToken, '[token]').replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]'); }
let browser, activePage, currentStep = 'setup', releaseStreams;
const streamsClosed = new Promise(resolve => { releaseStreams = resolve; });
async function check(name, fn) { currentStep = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflows horizontally');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input:not([type="checkbox"]), textarea')] });
}
async function fixture({ empty = false } = {}) {
  const state = { calls: [], seen: [], readAll: [], read: [], seenIds: new Set(), readIds: new Set(), water: [oldWater], proposals: [retrySaving] };
  const pages = empty ? { '': { items: [], nextCursor: null, watermark: 'empty-page' } } : {
    '': { items: first, nextCursor: 'next/cursor', watermark: 'first-page' },
    'next/cursor': { items: second, nextCursor: null, watermark: 'second-page' },
  };
  const snapshotIds = token => {
    const page = Object.values(pages).find(p => p.watermark === token);
    assert(page, 'Unknown snapshot token');
    return page.items.map(item => item.id);
  };
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
  contexts.push(context);
  await context.addInitScript(({ origin, token, refreshToken, uid }) => {
    if (location.origin !== origin || sessionStorage.getItem('__notifications_fixture')) return;
    localStorage.clear();
    localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: `fixture-${uid}`, tokens: { accessToken: token, refreshToken } }));
    localStorage.setItem('lw.accessToken', token); localStorage.setItem('lw.refreshToken', refreshToken);
    sessionStorage.setItem('__notifications_fixture', '1');
  }, { origin: UI.origin, token, refreshToken, uid });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin !== UI.origin) { errors.push(`Blocked external ${request.resourceType()} request`); return route.abort('blockedbyclient'); }
    if (p !== '/api' && !p.startsWith('/api/')) {
      if (request.resourceType() === 'document' || /^(\/assets\/|\/icons\/|\/icon\.svg$|\/favicon|\/manifest|\/app-lock-bootstrap\.(js|css)$|\/sw\.js$)/.test(p)) return route.continue();
      errors.push(`Unexpected static request ${p}`); return route.abort('blockedbyclient');
    }
    state.calls.push(`${method} ${p}${url.search}`);
    const send = data => route.fulfill({ status: 200, json: { data } });
    try {
      assert.equal(request.headers().authorization, `Bearer ${token}`, `Unexpected fixture authentication on ${p}`);
      if (method === 'GET' && p === '/api/realtime') { await streamsClosed; return route.fulfill({ contentType: 'text/event-stream', body: ': fixture closed\n\n' }).catch(() => {}); }
      if (method === 'GET' && p === '/api/me') return send({ user, wallet, level: 1, exp: 0, couple });
      if (method === 'GET' && p === '/api/couple') return send(couple);
      if (method === 'GET' && p === '/api/privacy-lock') return send({ couple: false, friends: false, revision: 0 });
      if (method === 'GET' && p === '/api/push/config') return send({ enabled: false, publicKey: null });
      if (method === 'GET' && p === '/api/proposals') return send(state.proposals);
      if (method === 'GET' && p === '/api/water/pending') return send(state.water);
      if (method === 'GET' && p === '/api/market/redemptions/pending') return send([]);
      if (method === 'GET' && ['/api/stories/unread-count', '/api/market/unread-count'].includes(p)) return send({ count: 0 });
      if (method === 'GET' && p === '/api/notifications/unread') {
        const all = Object.values(pages).flatMap(page => page.items);
        return send({ notifications: all.filter(item => !state.seenIds.has(item.id)).length, notificationsSaturated: false });
      }
      if (method === 'GET' && p === '/api/notifications') {
        const cursor = url.searchParams.get('cursor') || '';
        assert(Object.hasOwn(pages, cursor), `Unknown cursor ${cursor}`);
        const result = pages[cursor];
        return send({ ...result, items: result.items.map(item => ({ ...item, read: state.readIds.has(item.id) })) });
      }
      if (method === 'POST' && p === '/api/notifications/seen') {
        const body = request.postDataJSON(); assert.deepEqual(Object.keys(body), ['watermark']);
        state.seen.push(body.watermark); for (const id of snapshotIds(body.watermark)) state.seenIds.add(id);
        return send({ ok: true });
      }
      if (method === 'POST' && p === '/api/notifications/read-all') {
        const body = request.postDataJSON(); assert.deepEqual(Object.keys(body), ['watermarks']);
        assert(Array.isArray(body.watermarks) && body.watermarks.length > 0 && body.watermarks.length <= 25);
        state.readAll.push([...body.watermarks]);
        for (const watermark of body.watermarks) for (const id of snapshotIds(watermark)) state.readIds.add(id);
        return send({ ok: true });
      }
      if (method === 'POST' && /^\/api\/notifications\/[^/]+\/read$/.test(p)) {
        const id = decodeURIComponent(p.split('/')[3]); assert(Object.values(pages).some(page => page.items.some(item => item.id === id)));
        state.read.push(id); state.readIds.add(id); return send({ ok: true });
      }
      if (method === 'GET' && p === `/api/stories/${missingId}`) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unavailable' } } });
      if (method === 'POST' && p === `/api/water/logs/${oldWaterId}/approve`) { state.water = []; return send({ logId: oldWaterId, status: 'approved', amountMl: 250, totalMl: 250, goalMl: null, goalMet: false }); }
      if (method === 'POST' && p === `/api/proposals/${savingId}/approve`) { state.proposals = []; return send({ ...retrySaving, status: 'approved', applicationState: 'applied' }); }
      throw new Error(`Unmocked API request ${method} ${p}`);
    } catch (error) { errors.push(diagnostic(error)); return route.fulfill({ status: 501, json: { error: { code: 'UNMOCKED_FIXTURE', message: 'Unexpected fixture request' } } }); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(`pageerror ${diagnostic(error)}`));
  activePage = page;
  return { page, state };
}
try {
  await mkdir(evidence, { recursive: true });
  const { chromium } = createRequire(path.join(tooling, 'package.json'))('playwright-core');
  const executablePath = process.env.CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  await access(executablePath);
  browser = await chromium.launch({ executablePath, headless: process.env.LW_HEADED !== '1', args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  await check('Empty activity and old pending approvals remain separate', async () => {
    const { page, state } = await fixture({ empty: true });
    await page.goto(UI.origin + '/notifications');
    await page.getByText('Chưa có thông báo nào', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.notif').length === 0);
    await shot(page, 'empty-activity');
    assert.equal(state.readAll.length, 0); assert.equal(state.read.length, 0);
    await page.getByRole('button', { name: /Cần duyệt/ }).click();
    await page.getByText('Mục tiêu nước mới', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('Tạo quỹ chung', { exact: true }).waitFor();
    await page.getByText(/250 ml/).first().waitFor();
    await page.getByRole('button', { name: 'Thử lại', exact: true }).waitFor();
    await shot(page, 'old-pending-approvals');
    assert.equal(state.readAll.length, 0); assert.equal(state.read.length, 0);
  });
  await check('Seen snapshots do not read activity or loop; read-loaded excludes unloaded page', async () => {
    const { page, state } = await fixture();
    await page.goto(UI.origin + '/notifications');
    await page.getByText(/đã chụp khoảnh khắc hôm nay/).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.notif.is-unread').length === 2);
    await page.waitForTimeout(1200);
    assert.equal(state.seen.filter(x => x === 'first-page').length, 1, 'Repeated unchanged seen snapshot');
    assert.equal(state.readIds.size, 0); assert.equal(state.readAll.length, 0);
    await shot(page, 'activity-first-page');
    await page.getByRole('button', { name: 'Đọc các thông báo đã tải' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.notif.is-unread').length === 0);
    assert.deepEqual(state.readAll, [['first-page']]); assert(!state.readIds.has('n3'), 'Unloaded item was marked read');
    await page.getByRole('button', { name: 'Xem thêm' }).click();
    await page.getByText(/đã gửi một đề xuất cần bạn duyệt/).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.notif.is-unread').length === 1);
    await page.waitForTimeout(1200);
    assert.equal(state.seen.filter(x => x === 'second-page').length, 1);
    assert.equal(state.seen.filter(x => x === 'first-page').length, 1);
    await shot(page, 'activity-paginated');
    await page.getByRole('button', { name: 'Đọc các thông báo đã tải' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.notif.is-unread').length === 0);
    assert.deepEqual(state.readAll[1], ['first-page', 'second-page']); assert(state.readIds.has('n3'));
    await page.getByRole('button', { name: /Cần duyệt/ }).click();
    await page.getByText('Tạo quỹ chung', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Thử lại', exact: true }).waitFor();
    await page.getByText(/250 ml/).first().waitFor();
    assert.equal(state.water.length, 1); assert.equal(state.proposals.length, 1);
  });
  await check('Legacy approvals redirect and missing destination is neutral', async () => {
    const { page, state } = await fixture();
    await page.goto(UI.origin + '/approvals');
    await page.waitForURL(url => url.pathname === '/notifications' && url.searchParams.get('filter') === 'approvals');
    await page.getByText('Tạo quỹ chung', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hoạt động', exact: true }).click();
    await page.getByText(/đã chia sẻ một kỷ niệm/).click();
    await page.waitForURL(url => url.pathname === `/stories/${missingId}`);
    await page.getByText('Bài viết không còn nữa', { exact: true }).waitFor();
    assert.deepEqual(state.read, ['n2']); assert.equal(state.water.length, 1); assert.equal(state.proposals.length, 1);
    await shot(page, 'missing-target');
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, limits, viewport: { width: 360, height: 780 } }, null, 2));
  console.log(`PASS ${checks.length} checks; evidence ${evidence}`);
} catch (error) {
  const message = diagnostic(error); console.error(`FAIL ${currentStep}: ${message}\nEvidence: ${evidence}`);
  if (activePage) await shot(activePage, 'failure').catch(() => {});
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, currentStep, diagnostic: message, checks, errors, limits }, null, 2)); process.exitCode = 1;
} finally {
  releaseStreams();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
