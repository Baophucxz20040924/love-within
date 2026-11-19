// All-mocked mobile browser fixtures; an owned production preview must already be running.
// LW_UI_URL=http://localhost:5175 node frontend/tests/discovery/browser.mjs --local-mock-runtime
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
const evidence = path.join(os.tmpdir(), 'lw_discovery_browser', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const checks = [], errors = [], contexts = [], prefetchResults = [];
const limits = ['All APIs and sessions are synthetic. This tests frontend behavior, not backend authorization, persistence or real devices.', 'An already running owned local production frontend and external Playwright/Chromium are required.'];
const uid = '000000000000000000000001', partnerId = '000000000000000000000002', coupleId = '000000000000000000000003';
const outingId = '000000000000000000000004', token = 'synthetic-discovery-access', refreshToken = 'synthetic-discovery-refresh';
const user = { id: uid, displayName: 'Synthetic User', email: 'user@example.test', avatarUrl: null, coupleId, timezone: 'Asia/Ho_Chi_Minh' };
const partner = { id: partnerId, displayName: 'Synthetic Partner', email: 'partner@example.test', avatarUrl: null };
const wallet = { ownerUserId: uid, coinBalance: 0, exp: 0, level: 1, levelBaseExp: 0, nextLevelExp: 100 };
const couple = { id: coupleId, memberIds: [uid, partnerId], members: [user, partner], anniversaryDate: null, daysInLove: 0, nextMilestone: null, lastMilestone: null, level: 1, exp: 0, timezone: 'Asia/Ho_Chi_Minh' };
const date = '2026-11-16', timestamp = '2026-11-16T04:00:00.000Z';
const count = (used, max) => ({ used, max });
function ledger({ member = false, history = false } = {}) {
  const expense = { id: '000000000000000000000005', payerId: uid, title: 'Khoản đã hủy', amount: 10000, splitMode: 'equal', participantIds: [uid], allocations: [{ userId: uid, amount: 10000 }], status: 'void', createdAt: timestamp, updatedAt: timestamp };
  return { access: 'full', id: outingId, title: 'Buổi thử nghiệm', outingDate: date, creatorId: member ? partnerId : uid, myMembership: 'accepted', revision: 4, financeRevision: 2, phase: 'collecting', createdAt: timestamp, eventId: null,
    participants: [user, partner].map(u => ({ userId: u.id, displayName: u.displayName, status: 'accepted', consent: null })), expenses: history ? [expense] : [], settlements: [], balances: [uid, partnerId].map(userId => ({ userId, paid: 0, share: 0, sent: 0, received: 0, balance: 0, reservedOutgoing: 0, reservedIncoming: 0 })), suggestions: [], totalExpenses: 0,
    capacity: { participants: count(2, 20), expenses: count(history ? 1 : 0, 200), settlements: count(0, 200), edits: count(0, 200), ordinaryOperations: count(0, 200), reservedOperations: count(0, 200), editsFrozen: false, finalSettlementSlots: false } };
}
function diagnostic(error) { return String(error?.message || error).split('\nCall log:')[0].replaceAll(token, '[token]').replaceAll(refreshToken, '[token]').replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]'); }
async function check(name, fn) { currentStep = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflows horizontally');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input:not([type="checkbox"]), textarea')] });
}
let browser, activePage, currentStep = 'setup', releaseStreams;
const streamsClosed = new Promise(resolve => { releaseStreams = resolve; });
async function fixture({ pulseState = 'missing', friendError = false, member = false, history = false, space = 'couple', prefetch = null, desktop = false } = {}) {
  const state = { deleted: false, deletes: 0, calls: [], assets: [], failLists: false, outing: ledger({ member, history }) };
  const context = await browser.newContext({ viewport: desktop ? { width: 1280, height: 800 } : { width: 360, height: 780 }, isMobile: !desktop, hasTouch: !desktop, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
  if (prefetch) await context.addInitScript(options => {
    const queue = new Map(); let next = 0;
    let hidden = false, offline = false;
    window.requestIdleCallback = callback => { queue.set(++next, callback); return next; };
    window.cancelIdleCallback = id => queue.delete(id);
    window.__prefetchFixture = {
      queued: () => queue.size,
      constrain: () => { hidden = !!options.hidden; offline = !!options.offline; },
      run: () => {
        const entry = queue.entries().next().value;
        if (!entry) return false;
        queue.delete(entry[0]); entry[1]({ didTimeout: false, timeRemaining: () => 50 }); return true;
      },
    };
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: !!options.saveData, effectiveType: options.effectiveType || '4g' } });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !offline });
    if (options.hidden) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  }, prefetch);
  contexts.push(context);
  await context.addInitScript(({ origin, token, refreshToken, uid, space }) => {
    if (location.origin !== origin || sessionStorage.getItem('__discovery_fixture')) return;
    localStorage.clear();
    localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: `fixture-${uid}`, tokens: { accessToken: token, refreshToken } }));
    localStorage.setItem('lw.accessToken', token); localStorage.setItem('lw.refreshToken', refreshToken);
    if (space === 'friends') localStorage.setItem('lw.space', 'friends');
    sessionStorage.setItem('__discovery_fixture', '1');
  }, { origin: UI.origin, token, refreshToken, uid, space });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin !== UI.origin) { errors.push(`Blocked external ${request.resourceType()} request`); return route.abort('blockedbyclient'); }
    if (p !== '/api' && !p.startsWith('/api/')) {
      if (request.resourceType() === 'document' || /^(\/assets\/|\/icons\/|\/icon\.svg$|\/favicon|\/manifest|\/app-lock-bootstrap\.(js|css)$|\/sw\.js$)/.test(p)) {
        if (p.startsWith('/assets/')) state.assets.push(p);
        return route.continue();
      }
      errors.push(`Unexpected static request ${p}`); return route.abort('blockedbyclient');
    }
    state.calls.push(`${method} ${p}`);
    const send = data => route.fulfill({ status: 200, json: { data } });
    const fail = () => route.fulfill({ status: 503, json: { error: { code: 'FIXTURE_ERROR', message: 'Synthetic failure' } } });
    try {
      assert.equal(request.headers().authorization, `Bearer ${token}`, `Unexpected fixture authentication on ${p}`);
      if (method === 'GET' && p === '/api/realtime') { await streamsClosed; return route.fulfill({ contentType: 'text/event-stream', body: ': fixture closed\n\n' }).catch(() => {}); }
      if (method === 'GET' && p === '/api/me') return send({ user, wallet, level: 1, exp: 0, couple });
      if (method === 'GET' && p === '/api/couple') return send(couple);
      if (method === 'GET' && p === '/api/couple/pulse') {
        if (pulseState === 'error' && state.failLists) return fail();
        return send({ question: null, moment: pulseState === 'missing' ? null : { localDate: date, scheduleVersion: 3, sessionId: null, state: pulseState, windowEndsAt: null, rewardEndsAt: null, closesAt: null, partnerPosted: pulseState === 'both' }, letters: null, nextEvent: null, savings: null });
      }
      if (method === 'GET' && p === '/api/questions/today') return send(null);
      if (method === 'GET' && p === '/api/quests/today') return send([]);
      if (method === 'GET' && p === '/api/checkin') return send({ checkedInToday: false, streak: 0 });
      if (method === 'GET' && p === '/api/privacy-lock') return send({ couple: false, friends: false, revision: 0 });
      if (method === 'GET' && p === '/api/push/config') return send({ enabled: false, publicKey: null });
      if (method === 'GET' && ['/api/proposals', '/api/water/pending', '/api/market/redemptions/pending', '/api/ledger'].includes(p)) return send([]);
      if (method === 'GET' && ['/api/stories/unread-count', '/api/market/unread-count'].includes(p)) return send({ count: 0 });
      if (method === 'GET' && p === '/api/wallet') return send(wallet);
      if (method === 'GET' && p === '/api/water/today') return send({ localDate: date, goalMl: 2000, approvedMl: 0, pendingMl: 0, logs: [], partner: null });
      if (method === 'GET' && p === '/api/finance/connection') return send({ linked: false, status: null, visibility: 'private', accountLast4: null, lastError: null, lastSuccessAt: null });
      if (method === 'GET' && p === '/api/moments/today') return send({ localDate: date, legacy: false, scheduleVersion: 3, sessions: [] });
      if (method === 'GET' && p === '/api/moments') return send({ today: date, minMonth: '2020-01', days: [], streak: { current: 0, best: 0 } });
      if (method === 'GET' && p === '/api/events') return send({ upcoming: [], past: [] });
      if (method === 'GET' && p === '/api/notifications/unread') return send({ notifications: 0, notificationsSaturated: false });
      if (method === 'GET' && p === '/api/friends/unread') return send({ friendRequests: 0, notifications: 0, notificationsSaturated: false });
      if (method === 'GET' && p === '/api/friends') return send({ friends: [], incoming: [], outgoing: [] });
      if (method === 'GET' && p === '/api/friends/stories') return send({ items: [], nextCursor: null });
      if (method === 'GET' && p === '/api/friends/events') return friendError && state.failLists ? fail() : send({ items: [] });
      if (method === 'GET' && p === '/api/friends/outings') return send({ items: state.deleted ? [] : [{ ...state.outing, memberCount: 2 }], nextCursor: null });
      if (method === 'GET' && p === `/api/friends/outings/${outingId}` && !state.deleted) return send(state.outing);
      if (method === 'DELETE' && p === `/api/friends/outings/${outingId}` && !state.deleted) {
        assert(!member && !history, 'Delete must not be sent by member or for financial history');
        const body = request.postDataJSON();
        assert.equal(body.expectedRevision, state.outing.revision); assert.equal(typeof body.operationId, 'string'); assert(body.operationId.length > 0);
        state.deleted = true; state.deletes++;
        return send({ deletedId: outingId, outcome: { operationId: body.operationId, kind: 'delete', resultId: outingId, committedRevision: state.outing.revision + 1, replayed: false } });
      }
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
  for (const pulseState of ['missing', 'waiting', 'posted', 'both', 'error']) {
    await check(`Home discovery links with ${pulseState} pulse`, async () => {
      const { page, state } = await fixture({ pulseState });
      const pulseResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/couple/pulse');
      await page.goto(UI.origin + '/');
      await pulseResponse;
      const nav = page.getByRole('navigation', { name: 'Khám phá cùng nhau' });
      await nav.waitFor();
      // Initial authorization must succeed; fail only a later poll, not privacy revalidation.
      if (pulseState === 'error') {
        state.failLists = true;
        await page.getByText('Chưa cập nhật được hoạt động', { exact: true }).waitFor({ timeout: 45000 });
      }
      else await page.getByText('Đang tải hoạt động của hai bạn…', { exact: true }).waitFor({ state: 'hidden' });
      await shot(page, `home-${pulseState}`);
      for (const [label, target, empty] of [['Khoảnh khắc', '/moments', 'Tháng này chưa có ảnh nào.'], ['Sự kiện', '/events', 'Chưa có sự kiện nào']]) {
        const link = nav.getByRole('link', { name: new RegExp(label) });
        assert.equal(await link.getAttribute('href'), target); await link.click();
        await page.waitForURL(url => url.pathname === target); await page.getByText(empty, { exact: true }).waitFor();
        if (pulseState === 'missing') await shot(page, `${target.slice(1)}-empty`);
        await page.goBack(); await nav.waitFor();
      }
    });
  }
  for (const friendError of [false, true]) {
    await check(`Friends strip ${friendError ? 'error' : 'empty'} keeps creation available`, async () => {
      const { page, state } = await fixture({ friendError, space: 'friends' });
      if (friendError) {
        // Complete startup verification on a different page, then enter the feed
        // through the real bottom navigation with a failed event-list response.
        await page.goto(UI.origin + '/friends/outings');
        await page.getByRole('link', { name: /Buổi thử nghiệm/ }).waitFor();
        state.failLists = true;
        await page.locator('a[href="/friends"]').first().click();
      } else await page.goto(UI.origin + '/friends');
      const strip = page.locator('section.fev-strip');
      await strip.getByText(friendError ? 'Không tải được kèo.' : 'Chưa có kèo nào sắp tới. Rủ bạn bè đi đâu đó nhé!', { exact: !friendError }).waitFor();
      await shot(page, `friends-strip-${friendError ? 'error' : 'empty'}`);
      assert.equal(await strip.getByRole('link', { name: 'Xem tất cả' }).getAttribute('href'), '/friends/events');
      await strip.getByRole('button', { name: 'Lên kèo' }).click();
      await page.getByRole('dialog', { name: 'Lên kèo' }).waitFor();
      await shot(page, `friends-${friendError ? 'error' : 'empty'}`);
    });
  }
  await check('Creator cancels then deletes an empty outing', async () => {
    const { page, state } = await fixture({ space: 'friends' });
    await page.goto(UI.origin + '/friends/outings');
    await page.getByRole('link', { name: /Buổi thử nghiệm/ }).click();
    await page.waitForURL(url => url.pathname === `/friends/outings/${outingId}`);
    const button = page.getByRole('button', { name: 'Xóa buổi chia tiền', exact: true });
    await button.click(); const dialog = page.getByRole('dialog', { name: 'Xóa buổi chia tiền?' });
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal(state.deletes, 0);
    await button.click(); await dialog.waitFor(); await shot(page, 'delete-confirm');
    await dialog.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await page.waitForURL(url => url.pathname === '/friends/outings');
    await page.getByText('Buổi vui tiếp theo, bắt đầu ở đây', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Buổi thử nghiệm/ }).count(), 0); assert.equal(state.deletes, 1);
    await shot(page, 'delete-success');
  });
  for (const scenario of [{ member: true }, { history: true }]) {
    await check(`${scenario.member ? 'Member' : 'Creator with void expense history'} cannot delete`, async () => {
      const { page, state } = await fixture({ ...scenario, space: 'friends' });
      await page.goto(UI.origin + `/friends/outings/${outingId}`);
      await page.getByRole('heading', { name: 'Buổi thử nghiệm' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Xóa buổi chia tiền', exact: true }).count(), 0);
      if (scenario.history) { await page.getByText('Khoản đã hủy', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Lịch sử' }).click(); await page.getByText('Đã hủy khoản chi', { exact: true }).waitFor(); }
      assert.equal(state.deletes, 0); await shot(page, scenario.member ? 'member-no-delete' : 'void-history-no-delete');
    });
  }
  const candidatePattern = /\/(?:QuestsPage|StoriesPage|FriendsPeoplePage|FriendEventsPage)-[^/]+\.js$/;
  const forbiddenPattern = /\/(?:FinanceAssistantPage|FinanceGuidePage|NotificationSettingsPage|MoodHistoryPage|AdminApp|StoryDetailPage|SavingsDetailPage)-[^/]+\.js$/;
  for (const options of [
    { label: 'couple-visible', space: 'couple', desktop: true },
    { label: 'friends-visible', space: 'friends' },
    { label: 'data-saver', space: 'couple', saveData: true },
    { label: 'slow-network', space: 'couple', effectiveType: '3g' },
    { label: 'hidden', space: 'couple', hidden: true },
    { label: 'offline', space: 'couple', offline: true },
  ]) {
    await check(`Bounded prefetch ${options.label}`, async () => {
      const { page, state } = await fixture({ space: options.space, desktop: options.desktop, prefetch: options });
      await page.goto(UI.origin + (options.space === 'friends' ? '/friends' : '/'));
      await page.getByRole('navigation', { name: options.space === 'friends' ? 'Điều hướng Hội bạn bè' : 'Khám phá cùng nhau' }).waitFor();
      await page.waitForTimeout(300);
      const blocked = options.saveData || options.effectiveType === '3g' || options.hidden || options.offline;
      if (options.hidden || options.offline) {
        // Startup verification intentionally requires foreground connectivity.
        // Constrain after the shell mounts but before any speculative callback runs.
        assert.equal(await page.evaluate(() => window.__prefetchFixture.queued()), 1);
        await page.evaluate(() => { window.__prefetchFixture.constrain(); window.__prefetchFixture.run(); });
        assert.equal(await page.evaluate(() => window.__prefetchFixture.queued()), 0);
      } else if (blocked) {
        assert.equal(await page.evaluate(() => window.__prefetchFixture.queued()), 0);
      } else {
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => window.__prefetchFixture.run());
          await page.waitForTimeout(250);
        }
        const warmed = [...new Set(state.assets.filter(p => candidatePattern.test(p)))];
        const expected = options.space === 'friends' ? ['FriendsPeoplePage', 'FriendEventsPage'] : ['QuestsPage', 'StoriesPage'];
        assert.equal(warmed.length, 2, 'Only the two selected route entry chunks should be warmed');
        for (const name of expected) assert(warmed.some(p => p.includes(`/${name}-`)), `${name} was not prefetched`);
      }
      assert.equal(state.assets.some(p => forbiddenPattern.test(p)), false, 'Secondary routes should not be speculatively warmed');
      if (blocked) assert.equal(state.assets.some(p => candidatePattern.test(p)), false);
      prefetchResults.push({ label: options.label, viewport: page.viewportSize(), routeEntryChunks: [...new Set(state.assets.filter(p => candidatePattern.test(p)))].map(p => p.split('/').at(-1)), apiCalls: [...state.calls] });
      await shot(page, `prefetch-${options.label}`);
      if (options.saveData) {
        // A disabled speculative pass must not disable ordinary lazy navigation.
        await page.goto(UI.origin + '/finance/guide');
        await page.getByRole('heading', { name: 'Hướng dẫn liên kết', exact: true }).waitFor();
        assert(state.assets.some(p => /\/FinanceGuidePage-[^/]+\.js$/.test(p)));
        assert.equal(await page.evaluate(() => window.__prefetchFixture.queued()), 0);
        await shot(page, 'direct-route-with-prefetch-disabled');
      }
      await page.close();
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, limits, prefetchResults, viewport: { width: 360, height: 780 } }, null, 2));
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
