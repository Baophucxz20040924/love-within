// Controlled local API response races, initiated by real UI; no module imports into the app.
// Requires the private synthetic fixture from v12-baseline.mjs. No servers are launched.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-session-${Date.now()}`);
const h = await import('./harness.mjs');
const errors = []; const passed = []; let browser;
const releases = [];
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled request not observed within 15s')), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function json(route, status, body) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {}); }
try {
  h.assert(process.env.LW_BASELINE_FIXTURE, 'Set LW_BASELINE_FIXTURE to the private synthetic v12 baseline fixture');
  const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
  h.assert(fixture.synthetic && fixture.users?.length >= 2, 'Synthetic paired fixture required');
  const [a, b] = fixture.users;
  browser = await h.openBrowser();
  for (const fault of ['late-original-401', 'late-refresh-success', 'late-refresh-401']) {
    const { context, page } = await h.fresh(browser, fault, errors);
    await h.login(page, a);
    const other = await context.newPage(); await other.goto(`${h.baseURL}/profile`);
    await other.getByRole('button', { name: 'Đăng xuất', exact: true }).waitFor();
    const arrived = gate(); const held = gate(); const completed = gate(); releases.push(held.resolve);
    let armed = true; let original401s = 0; let refreshes = 0;
    // Capture solely in memory. Neither request bodies nor response tokens enter result artifacts.
    const oldTokens = await page.evaluate(() => ({ accessToken: localStorage.getItem('lw.accessToken'), refreshToken: localStorage.getItem('lw.refreshToken') }));
    await context.route('**/api/**', async route => {
      const req = route.request(); const url = new URL(req.url());
      const owned = req.frame().page() === page;
      // Always create exactly one original 401 before exercising the refresh branch.
      if (owned && armed && url.pathname === '/api/bucket' && req.method() === 'GET') {
        armed = false; original401s++;
        if (fault === 'late-original-401') { arrived.resolve(); await held.promise; }
        await json(route, 401, { error: { code: 'TEST_OLD_401', message: 'Old request rejected' } });
        if (fault === 'late-original-401') completed.resolve();
        return;
      }
      if (owned && url.pathname === '/api/auth/refresh') {
        refreshes++;
        if (fault !== 'late-original-401') {
          arrived.resolve(); await held.promise;
          await json(route, fault === 'late-refresh-success' ? 200 : 401,
            fault === 'late-refresh-success' ? { data: oldTokens } : { error: { code: 'TEST_OLD_REFRESH', message: 'Old refresh rejected' } });
          completed.resolve(); return;
        }
      }
      await route.continue();
    });
    await page.goto(`${h.baseURL}/quests/bucket`); await bounded(arrived.promise);
    h.assert.equal(original401s, 1, `${fault} must produce exactly one original /api/bucket 401`);
    if (fault === 'late-original-401') h.assert.equal(refreshes, 0, 'Held original 401 must not refresh before logout/login');
    else h.assert.equal(refreshes, 1, `${fault} must hold exactly one refresh request`);
    await other.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await other.waitForURL(url => url.pathname === '/login');
    await h.login(other, b);
    const nextSession = await other.evaluate(() => ({ generation: localStorage.getItem('lw.sessionGeneration'), access: localStorage.getItem('lw.accessToken') }));
    held.resolve(); await bounded(completed.promise);
    // A real navigation/API roundtrip settles the new account after releasing the fault.
    await other.goto(`${h.baseURL}/profile`);
    await other.getByRole('button', { name: 'Đăng xuất', exact: true }).waitFor();
    h.assert(await other.evaluate(expected => localStorage.getItem('lw.sessionGeneration') === expected.generation && localStorage.getItem('lw.accessToken') === expected.access, nextSession), 'Old response altered the new session');
    if (fault === 'late-original-401') h.assert.equal(refreshes, 0, 'Old 401 must not refresh the new session');
    passed.push(`${fault}: cross-tab logout/login B survives A response`);
    await context.close();
  }
  {
    const { context, page } = await h.fresh(browser, 'hung-push-logout', errors);
    await h.login(page, a); await page.goto(`${h.baseURL}/profile`);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).waitFor();
    // Synthetic ownership only; never invokes a real push provider or subscription.
    await page.evaluate(id => localStorage.setItem('lw.push.device', JSON.stringify({ userId: id, space: 'couple', endpoint: 'https://example.invalid/v12-local-only', syncedAt: Date.now() })), a.id);
    const arrived = gate(); const held = gate(); releases.push(held.resolve);
    await page.route('**/api/push/subscriptions', async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      arrived.resolve(); await held.promise; await json(route, 200, { data: { ok: true } });
    });
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await bounded(arrived.promise);
    await page.waitForURL(url => url.pathname === '/login', { timeout: 2000 });
    h.assert(await page.evaluate(() => !localStorage.getItem('lw.accessToken') && !localStorage.getItem('lw.refreshToken') && !localStorage.getItem('lw.push.device')), 'Logout did not clear credentials/ownership while push DELETE hung');
    await h.login(page, b); held.resolve();
    await page.goto(`${h.baseURL}/profile`); await page.getByRole('button', { name: 'Đăng xuất', exact: true }).waitFor();
    passed.push('logout clears immediately during hung push DELETE; subsequent login survives cleanup');
    await context.close();
  }
  for (const fault of ['late-read-success', 'late-mutation-success']) {
    const { context, page } = await h.fresh(browser, fault, errors);
    await h.login(page, a);
    const other = await context.newPage(); await other.goto(`${h.baseURL}/profile`);
    await other.getByRole('button', { name: 'Đăng xuất', exact: true }).waitFor();
    const arrived = gate(); const held = gate(); const completed = gate(); releases.push(held.resolve);
    const sentinel = `V12 old-session ${fault}`;
    let armed = true;
    await context.route('**/api/**', async route => {
      const req = route.request(); const url = new URL(req.url());
      const owned = req.frame().page() === page;
      const target = fault === 'late-read-success'
        ? url.pathname === '/api/bucket' && req.method() === 'GET'
        : url.pathname === '/api/savings/propose' && req.method() === 'POST';
      if (owned && armed && target) {
        armed = false; arrived.resolve(); await held.promise;
        // UI-only synthetic success: no financial write is sent to the server.
        await json(route, 200, { data: fault === 'late-read-success'
          ? { items: [{ id: '000000000000000000000001', title: sentinel, emoji: '🌿', category: 'other', status: 'todo', pinned: false }], counts: { todo: 1, done: 0 } }
          : { id: '000000000000000000000002', title: sentinel } });
        completed.resolve(); return;
      }
      await route.continue();
    });
    if (fault === 'late-read-success') await page.goto(`${h.baseURL}/quests/bucket`);
    else {
      await page.goto(`${h.baseURL}/savings`);
      await page.getByRole('button', { name: 'Tạo quỹ', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Đề xuất quỹ mới', exact: true });
      await sheet.getByLabel('Tên quỹ', { exact: true }).fill(sentinel);
      await sheet.getByLabel('Mục tiêu (VND)', { exact: false }).fill('100000');
      await sheet.getByRole('button', { name: 'Gửi đề xuất', exact: true }).click();
    }
    await bounded(arrived.promise);
    await other.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await other.waitForURL(url => url.pathname === '/login');
    await h.login(other, b);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const nextSession = await other.evaluate(() => ({ generation: localStorage.getItem('lw.sessionGeneration'), access: localStorage.getItem('lw.accessToken') }));
    held.resolve(); await bounded(completed.promise);
    // Keep the original document/query client alive: a full reload would hide cache leakage.
    await page.evaluate(() => { history.pushState(null, '', '/quests/bucket'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('heading', { name: 'Bucket list', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Thêm mục', exact: true }).waitFor();
    h.assert.equal(await page.getByText(sentinel, { exact: false }).count(), 0, 'Old success leaked content into the new session');
    h.assert.equal(await page.getByText('Đã gửi đề xuất, chờ người ấy đồng ý.', { exact: true }).count(), 0, 'Old mutation emitted a success toast after session change');
    h.assert(await page.evaluate(expected => localStorage.getItem('lw.sessionGeneration') === expected.generation && localStorage.getItem('lw.accessToken') === expected.access, nextSession), 'Old successful response changed the new session');
    passed.push(`${fault}: no old content/success toast in original document after login B`);
    await context.close();
  }
  {
    const { context, page } = await h.fresh(browser, 'same-tab-duplicate-submit', errors);
    await page.goto(`${h.baseURL}/login`);
    const arrived = gate(); const held = gate(); const completed = gate(); releases.push(held.resolve);
    let submissions = 0;
    await page.route('**/api/auth/login', async route => {
      submissions++; arrived.resolve(); await held.promise;
      // Do not consume a real login attempt; this checks the UI's pending exclusion.
      await json(route, 400, { error: { code: 'VALIDATION_ERROR', message: 'V12 controlled pending login' } });
      completed.resolve();
    });
    await page.getByLabel('Email', { exact: true }).fill(a.email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(a.password);
    const submit = page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true });
    await submit.click(); await bounded(arrived.promise);
    await h.assert(await submit.isDisabled(), 'Pending login submit must be disabled');
    h.assert(await page.getByLabel('Email', { exact: true }).isDisabled(), 'Pending login identity must be locked');
    // Submit again through the form while the original request is pending. Focus an enabled
    // non-submit control first so this is not Enter on the disabled submit button.
    await page.getByRole('button', { name: 'Trái tim', exact: true }).focus();
    await page.locator('form').evaluate(form => form.requestSubmit());
    h.assert.equal(submissions, 1, 'Same-tab form submission started an overlapping login request');
    held.resolve(); await bounded(completed.promise);
    await page.getByRole('alert').filter({ hasText: 'V12 controlled pending login' }).waitFor();
    h.assert.equal(submissions, 1, 'Same-tab repeated activation submitted overlapping logins');
    h.assert.equal(await page.evaluate(() => localStorage.getItem('lw.accessToken')), null, 'Controlled rejection unexpectedly authenticated');
    passed.push('same-tab pending login excludes duplicate keyboard submission');
    await context.close();
  }
  // Consume only the controlled response errors, scoped to the case label and exact path/count.
  const expectedHttp = new Map([
    ['late-original-401|401|/api/bucket', 1],
    ['late-refresh-success|401|/api/bucket', 1],
    ['late-refresh-401|401|/api/bucket', 1],
    ['late-refresh-401|401|/api/auth/refresh', 1],
    ['same-tab-duplicate-submit|400|/api/auth/login', 1],
  ]);
  const expectedConsole = new Map([
    ['late-original-401|401', 1],
    ['late-refresh-success|401', 1],
    ['late-refresh-401|401', 2],
    ['same-tab-duplicate-submit|400', 1],
  ]);
  const unexpected = [];
  for (const error of errors) {
    if (error.type === 'http') {
      const key = `${error.label}|${error.status}|${error.path}`;
      const remaining = expectedHttp.get(key) ?? 0;
      if (remaining > 0) expectedHttp.set(key, remaining - 1);
      else unexpected.push(error);
      continue;
    }
    if (error.type === 'console') {
      const status = /status of (400|401)/.exec(error.message)?.[1];
      const key = status && `${error.label}|${status}`;
      const remaining = key ? (expectedConsole.get(key) ?? 0) : 0;
      if (key && remaining > 0) expectedConsole.set(key, remaining - 1);
      else unexpected.push(error);
      continue;
    }
    unexpected.push(error);
  }
  h.assert.deepEqual([...expectedHttp].filter(([, count]) => count > 0), [], 'A controlled HTTP error was not observed');
  h.assert.deepEqual(unexpected, [], 'Unexpected browser errors');
  h.assert.deepEqual([...expectedConsole].filter(([, count]) => count > 0), [], 'A controlled console error was not observed');
  await h.writeResult({ suite: 'v12-session', passed, expectedFaults: ['GET /api/bucket 401', 'POST /api/auth/refresh 401 or delayed 200', 'hung DELETE /api/push/subscriptions'], limitations: ['Same-tab overlap checks pending UI exclusion, not direct concurrent AuthContext calls', 'Delayed read/mutation successes are controlled browser responses, not real server commits', 'No real push subscription or provider', 'No tokens, screenshots, traces or storageState saved'] });
  console.log(`PASS ${passed.length} cases; result ${h.evidenceDir}`);
} catch (error) {
  await h.writeResult({ suite: 'v12-session', passed, failure: h.sanitize(error.message), errors });
  console.error(h.sanitize(error.message)); process.exitCode = 1;
} finally { releases.forEach(release => release()); await browser?.close(); }
