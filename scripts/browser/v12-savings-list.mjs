// Prepared for a later coordinator-run browser check. Does not start servers or seed data.
// LW_BASELINE_FIXTURE=<private existing paired-users JSON> node scripts/browser/v12-savings-list.mjs
// node scripts/browser/v12-savings-list.mjs --validate   (pure fixtures only, no harness/browser)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const createdAt = '2026-01-01T00:00:00.000Z';
const goal = (number, status = 'active') => ({
  id: number.toString(16).padStart(24, '0'), title: `V12 synthetic ${status} ${number}`,
  emoji: '', totalVnd: 0, targetVnd: 1_000_000, status, reachedAt: null,
  dueOn: null, createdBy: '000000000000000000000001', createdAt, updatedAt: createdAt,
  pinned: false, contributions: [], forecastOn: null, version: 1,
});
// Same timestamp and descending id match the server's (createdAt, _id) keyset ordering.
const openGoals = Array.from({ length: 21 }, (_, index) => goal(121 - index));
const closedGoal = goal(200, 'closed');
const cursor = `${createdAt}_${openGoals[19].id}`;
const firstPage = { items: openGoals.slice(0, 20), nextCursor: cursor };
const lastPage = { items: openGoals.slice(20), nextCursor: null };
const closedPage = { items: [closedGoal], nextCursor: null };
const label = 'savings-list';
// App.tsx QueryClient defaults queries.retry=1; savingsListOptions does not override it.
const fault = { label: 'open-next-page-503', browserLabel: label, method: 'GET', path: '/api/savings', status: 503, count: 2 };
const faultMessage = 'Synthetic next-page fixture temporarily unavailable';
const connection = { linked: true, status: 'active', bankBrand: 'MBBank', accountLast4: '0012', lastSuccessAt: createdAt, lastError: null, visibility: 'private' };
const transaction = { id: '000000000000000000000301', direction: 'out', amount: 12000, occurredAt: createdAt, localDate: createdAt.slice(0, 10), note: 'V12 synthetic bank transaction', isMine: true };
const oldQuery = 'older';
const newQuery = 'newest';
const oldGoal = { ...goal(401), title: 'V12 older result must not leak' };
const searchGoals = Array.from({ length: 21 }, (_, index) => ({ ...goal(521 - index), title: `V12 newest result ${index + 1}` }));
const searchCursor = `${createdAt}_${searchGoals[19].id}`;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled browser request not observed within 15s')), 15000); })]); }
  finally { clearTimeout(timer); }
}

function validateFixtures() {
  assert.equal(new Set(openGoals.map(item => item.id)).size, 21);
  assert.equal(firstPage.items.length, 20);
  assert.equal(lastPage.items.length, 1);
  assert.equal(new Set(openGoals.map(item => item.createdAt)).size, 1);
  assert(openGoals.every((item, index) => index === 0 || openGoals[index - 1].id > item.id));
  assert.equal(firstPage.nextCursor, `${firstPage.items.at(-1).createdAt}_${firstPage.items.at(-1).id}`);
  assert(openGoals.every(item => item.status === 'active'));
  assert.equal(closedPage.items[0].status, 'closed');
  assert.equal(connection.linked, true);
  assert.equal(connection.visibility, 'private');
  assert.equal(transaction.isMine, true);
  assert.equal(transaction.direction, 'out');
  assert.equal(new Set(searchGoals.map(item => item.id)).size, 21);
  assert.equal(searchCursor, `${searchGoals[19].createdAt}_${searchGoals[19].id}`);
  assert(!searchGoals.some(item => item.id === oldGoal.id));
  for (const item of [...openGoals, closedGoal, oldGoal, ...searchGoals]) {
    assert.match(item.id, /^[a-f0-9]{24}$/);
    assert.equal(item.totalVnd, item.contributions.reduce((sum, member) => sum + member.amountVnd, 0));
    assert(Number.isInteger(item.targetVnd) && item.targetVnd > 0);
  }
}
validateFixtures();

if (process.argv.includes('--validate')) {
  console.log('Fixture validation only: same-timestamp 20+1 list/search DTOs, closed DTO and private synthetic finance DTOs. Browser assertions NOT RUN.');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-savings-list-${Date.now()}`);
  const h = await import('./harness.mjs');
  const errors = [], passed = [], requests = [], routeViolations = [], mutationAttempts = [];
  let browser, context, failure, failedNextPages = 0, permitNextPage = false, financePhase = false, syntheticSyncs = 0;
  const oldArrived = gate(), newArrived = gate(), releaseOld = gate(), releaseNew = gate(), oldDelivered = gate();
  const searchRequests = [];
  const limitations = [
    'Browser runtime not implied by node --check or --validate; inspect this run result.',
    'GET fixtures validate frontend paging/filter behavior, not database keyset pagination.',
    'Finance and search responses are synthetic; sync POST is fulfilled locally and never reaches a bank provider. No note or attachment mutation is submitted.',
    '300ms debounce checks use controlled request gates plus short idle windows, not a timing-performance benchmark.',
    'Existing private synthetic paired users are required. Only real UI login is performed; no API setup/seeding, storage injection, traces or screenshots.',
  ];
  const step = async (name, fn) => { await fn(); passed.push(name); };
  const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { data } : { error: data }) });
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE must name a private existing synthetic fixture');
    const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(fixture.synthetic === true && fixture.users?.length >= 2, 'Existing synthetic paired two-user fixture required');
    for (const user of fixture.users.slice(0, 2)) assert(user.email && user.password, 'Fixture credentials missing');
    browser = await h.openBrowser();
    const fresh = await h.fresh(browser, label, errors);
    context = fresh.context;
    const { page } = fresh;
    await h.login(page, fixture.users[0]); // Real login form only. Never h.api() or localStorage tokens.
    await context.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (financePhase && request.method() === 'POST' && url.pathname === '/api/finance/connection/sync') {
        syntheticSyncs++;
        return json(route, { connection, synced: false, inserted: 0, error: null });
      }
      if (request.method() !== 'GET') {
        // Only the explicitly synthetic sync above is allowed after login.
        mutationAttempts.push({ method: request.method(), path: url.pathname });
        await route.abort('blockedbyclient');
        return;
      }
      if (financePhase && url.pathname.startsWith('/api/finance/')) {
        try {
          if (url.pathname === '/api/finance/connection') {
            assert.equal(url.search, '');
            return await json(route, connection);
          }
          const month = url.searchParams.get('month');
          assert.match(month ?? '', /^\d{4}-\d{2}$/);
          if (url.pathname === '/api/finance/summary') {
            assert.deepEqual([...url.searchParams.keys()], ['month']);
            return await json(route, { month, totalIn: 0, totalOut: transaction.amount, net: -transaction.amount, count: 1 });
          }
          assert.equal(url.pathname, '/api/finance/transactions', 'Unexpected finance read');
          assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'month']);
          assert.equal(url.searchParams.get('limit'), '20');
          const localDate = `${month}-01`;
          return await json(route, { items: [{ ...transaction, localDate, occurredAt: `${localDate}T01:00:00.000Z` }], nextCursor: null });
        } catch (error) {
          routeViolations.push(h.sanitize(error.message));
          return route.abort('blockedbyclient');
        }
      }
      if (url.pathname === '/api/savings/suggestion') return json(route, { suggestion: null });
      if (url.pathname !== '/api/savings') return route.continue();
      const params = Object.fromEntries(url.searchParams);
      requests.push(params);
      try {
        assert.equal(url.searchParams.size, Object.keys(params).length, 'Duplicate query params');
        const keys = ['limit', 'status', ...(params.cursor ? ['cursor'] : []), ...(params.q ? ['q'] : [])].sort();
        assert.deepEqual(Object.keys(params).sort(), keys);
        assert.equal(params.limit, '20');
        if (financePhase) {
          searchRequests.push(params);
          assert.equal(params.status, 'open');
          if (!params.q) {
            assert.equal(params.cursor, undefined);
            return await json(route, firstPage);
          }
          assert([oldQuery, newQuery].includes(params.q), 'Unexpected intermediate/debounced search');
          if (params.q === oldQuery) {
            assert.equal(params.cursor, undefined);
            oldArrived.resolve();
            await releaseOld.promise;
            await json(route, { items: [oldGoal], nextCursor: null });
            oldDelivered.resolve();
            return;
          }
          if (params.cursor) {
            assert.equal(params.cursor, searchCursor, 'Search pagination must retain its own cursor');
            return await json(route, { items: searchGoals.slice(20), nextCursor: null });
          }
          newArrived.resolve();
          await releaseNew.promise;
          return await json(route, { items: searchGoals.slice(0, 20), nextCursor: searchCursor });
        }
        assert.equal(params.q, undefined);
        assert(['open', 'closed'].includes(params.status));
        if (params.status === 'closed') {
          assert.equal(params.cursor, undefined);
          return await json(route, closedPage);
        }
        if (!params.cursor) return await json(route, firstPage);
        assert.equal(params.cursor, cursor, 'Cursor must preserve timestamp and final id exactly');
        if (!permitNextPage) {
          failedNextPages++;
          assert(failedNextPages <= fault.count, 'Unexpected extra automatic retry');
          return await json(route, { code: 'TEST_NEXT_PAGE_UNAVAILABLE', message: faultMessage }, fault.status);
        }
        return await json(route, lastPage);
      } catch (error) {
        routeViolations.push(h.sanitize(error.message));
        await route.abort('blockedbyclient');
      }
    });
    const cards = page.locator('a.savings-card[href^="/savings/"]');
    const ids = () => cards.evaluateAll(elements => elements.map(element => element.getAttribute('href').split('/').at(-1)));
    async function expectIds(expected) {
      await page.waitForFunction(count => document.querySelectorAll('a.savings-card[href^="/savings/"]').length === count, expected.length);
      assert.deepEqual(await ids(), expected.map(item => item.id));
    }
    await step('open first page: 20 distinct cards and status=open&limit=20', async () => {
      await page.goto(`${h.baseURL}/savings`);
      await expectIds(firstPage.items);
      assert(requests.some(params => params.status === 'open' && params.limit === '20' && !params.cursor));
    });
    await step('next-page 503 including one automatic retry preserves all 20 cards', async () => {
      await page.getByRole('button', { name: 'Xem thêm quỹ', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Chưa tải được trang tiếp theo. Các quỹ đã tải vẫn được giữ.' }).waitFor();
      assert.equal(failedNextPages, fault.count, 'App retry=1 should yield exactly two failed responses');
      await expectIds(firstPage.items);
      await page.getByRole('button', { name: 'Thử lại trang tiếp theo', exact: true }).waitFor();
    });
    await step('explicit retry reuses exact cursor and yields 21 unique cards', async () => {
      permitNextPage = true;
      await page.getByRole('button', { name: 'Thử lại trang tiếp theo', exact: true }).click();
      await expectIds(openGoals);
      assert.equal(new Set(await ids()).size, 21);
      assert.equal(await page.getByRole('button', { name: /^(Xem thêm quỹ|Thử lại trang tiếp theo)$/ }).count(), 0);
      const next = requests.filter(params => params.cursor);
      assert.equal(next.length, 3, 'Two failed attempts plus one explicit retry');
      assert(next.every(params => params.cursor === cursor && params.status === 'open' && params.limit === '20'));
    });
    await step('closed status is isolated: only one closed card, no open cards', async () => {
      await page.getByRole('radiogroup', { name: 'Trạng thái quỹ' }).getByRole('radio', { name: 'Đã đóng', exact: true }).click();
      await expectIds([closedGoal]);
      assert(requests.some(params => params.status === 'closed' && params.limit === '20' && !params.cursor));
      for (const item of openGoals) assert.equal(await page.locator(`a.savings-card[href="/savings/${item.id}"]`).count(), 0);
    });
    await step('NoteSheet bank chooser uses synthetic finance reads and local sync only', async () => {
      financePhase = true;
      await page.goto(`${h.baseURL}/finance`);
      await page.getByRole('button', { name: /sửa ghi chú hoặc góp quỹ$/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Ghi chú giao dịch', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel('Ghi chú', { exact: true }).inputValue(), transaction.note);
      await dialog.getByRole('button', { name: 'Ghi là tiền góp quỹ…', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Chọn quỹ', exact: true }).waitFor();
      assert.equal(syntheticSyncs, 1, 'FinancePage mount must use exactly one locally fulfilled sync');
    });
    await step('debounced new query wins even when old results arrive last', async () => {
      const dialog = page.getByRole('dialog', { name: 'Ghi chú giao dịch', exact: true });
      const search = dialog.getByRole('searchbox', { name: 'Tìm quỹ đang mở', exact: true });
      const selected = dialog.getByRole('combobox', { name: 'Chọn quỹ', exact: true });
      // Retain the established selected-goal behavior across a search, then explicitly replace it.
      await selected.selectOption(openGoals[0].id);
      await search.fill(oldQuery);
      await bounded(oldArrived.promise); // Hold an old request after its debounce has fired.
      await search.fill('n');
      await search.fill('ne');
      await search.fill(newQuery);
      await bounded(newArrived.promise); // All intermediate queries must collapse into newest.
      assert.equal(searchRequests.filter(params => params.q && params.q !== oldQuery && params.q !== newQuery).length, 0);
      releaseNew.resolve();
      await page.waitForFunction(id => !!document.querySelector(`select[aria-label="Chọn quỹ"] option[value="${id}"]`), searchGoals[0].id);
      await selected.selectOption(searchGoals[0].id);
      releaseOld.resolve();
      await bounded(oldDelivered.promise);
      // Allow the delivered older cache result and any mistakenly scheduled debounce to render.
      await page.waitForTimeout(400);
      assert.equal(await search.inputValue(), newQuery);
      assert.equal(await selected.inputValue(), searchGoals[0].id);
      const values = await selected.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
      assert.deepEqual(values, searchGoals.slice(0, 20).map(item => item.id), 'Old query results or unfiltered list leaked into active query');
      assert.equal(await dialog.getByText(`Quỹ đã chọn: ${searchGoals[0].title}`, { exact: true }).count(), 1);
      assert.equal(await selected.locator(`option[value="${oldGoal.id}"]`).count(), 0);
    });
    await step('chooser load-more retains newest q/cursor and selection without attachment mutation', async () => {
      const dialog = page.getByRole('dialog', { name: 'Ghi chú giao dịch', exact: true });
      const selected = dialog.getByRole('combobox', { name: 'Chọn quỹ', exact: true });
      await dialog.getByRole('button', { name: 'Xem thêm quỹ', exact: true }).click();
      await page.waitForFunction(id => !!document.querySelector(`select[aria-label="Chọn quỹ"] option[value="${id}"]`), searchGoals[20].id);
      const values = await selected.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
      assert.deepEqual(values, searchGoals.map(item => item.id));
      assert.equal(new Set(values).size, 21);
      assert.equal(await selected.inputValue(), searchGoals[0].id, 'Loading another page must not replace selection');
      await selected.selectOption(searchGoals[20].id);
      assert.equal(await selected.inputValue(), searchGoals[20].id);
      assert.equal(await dialog.getByText(`Quỹ đã chọn: ${searchGoals[20].title}`, { exact: true }).count(), 1);
      assert(await dialog.getByRole('button', { name: 'Xác nhận góp quỹ', exact: true }).isEnabled());
      assert.equal(await dialog.getByRole('button', { name: 'Xem thêm quỹ', exact: true }).count(), 0);
      assert.deepEqual(searchRequests.filter(params => params.q).map(params => [params.q, params.cursor ?? null]), [[oldQuery, null], [newQuery, null], [newQuery, searchCursor]]);
      assert(searchRequests.every(params => params.status === 'open' && params.limit === '20'));
      // Deliberately do not click either save-note or attach: chooser read/selection only.
      assert.deepEqual(mutationAttempts, [], 'Search/selection must not dispatch a note or savings mutation');
    });
    assert.deepEqual(routeViolations, [], 'Unexpected savings query shape');
    assert.deepEqual(mutationAttempts, [], 'No post-login mutation may be invoked');
    // Exact fault allowlist: label/path/status/count; unrelated console/resource errors are never suppressed.
    const expectedHttp = errors.filter(error => error.label === fault.browserLabel && error.type === 'http' && error.path === fault.path && error.status === fault.status);
    const expectedConsole = errors.filter(error => error.label === fault.browserLabel && error.type === 'console' && error.path === fault.path && /^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/.test(error.message));
    assert.equal(expectedHttp.length, fault.count, 'Expected exact 503 HTTP count');
    assert.equal(expectedConsole.length, fault.count, 'Expected exact matching resource-console count');
    assert.deepEqual(errors.filter(error => !expectedHttp.includes(error) && !expectedConsole.includes(error)), [], 'Unexpected browser errors');
  } catch (error) {
    failure = h.sanitize(error.message);
    process.exitCode = 1;
  } finally {
    releaseOld.resolve();
    releaseNew.resolve();
    await context?.close();
    await browser?.close();
    await h.writeResult({ suite: 'v12-savings-list', ok: !failure, passed, ...(failure ? { failure } : {}), requests,
      errors, expectedFault: fault, failedNextPages, syntheticSyncs, searchRequests, mutationAttempts, routeViolations, limitations });
  }
  if (failure) console.error(failure);
  else console.log(`Completed ${passed.length} browser steps; evidence ${h.evidenceDir}.`);
}
