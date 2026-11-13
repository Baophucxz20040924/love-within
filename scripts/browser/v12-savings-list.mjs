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
const fault = { label: 'open-next-page-503', browserLabel: label, method: 'GET', path: '/api/savings', status: 503, count: 2 };
const faultMessage = 'Synthetic next-page fixture temporarily unavailable';

function validateFixtures() {
  assert.equal(new Set(openGoals.map(item => item.id)).size, 21);
  assert.equal(firstPage.items.length, 20);
  assert.equal(lastPage.items.length, 1);
  assert.equal(new Set(openGoals.map(item => item.createdAt)).size, 1);
  assert(openGoals.every((item, index) => index === 0 || openGoals[index - 1].id > item.id));
  assert.equal(firstPage.nextCursor, `${firstPage.items.at(-1).createdAt}_${firstPage.items.at(-1).id}`);
  assert(openGoals.every(item => item.status === 'active'));
  assert.equal(closedPage.items[0].status, 'closed');
  for (const item of [...openGoals, closedGoal]) {
    assert.match(item.id, /^[a-f0-9]{24}$/);
    assert.equal(item.totalVnd, item.contributions.reduce((sum, member) => sum + member.amountVnd, 0));
    assert(Number.isInteger(item.targetVnd) && item.targetVnd > 0);
  }
}
validateFixtures();

if (process.argv.includes('--validate')) {
  console.log('Fixture validation only: 21 same-timestamp ordered open DTOs, 20+1 cursor pages, one closed DTO. Browser assertions NOT RUN.');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-savings-list-${Date.now()}`);
  const h = await import('./harness.mjs');
  const errors = [], passed = [], requests = [], routeViolations = [], mutationAttempts = [];
  let browser, context, failure, failedNextPages = 0, permitNextPage = false;
  const limitations = [
    'Browser runtime not implied by node --check or --validate; inspect this run result.',
    'GET fixtures validate frontend paging/filter behavior, not database keyset pagination.',
    'BankSavingsAction q/debounce/delayed-response isolation remains pending; no finance fixture or provider action in this script.',
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
      if (request.method() !== 'GET') {
        // No post-login write, including accidental savings mutations, may reach the server.
        mutationAttempts.push({ method: request.method(), path: url.pathname });
        await route.abort('blockedbyclient');
        return;
      }
      if (url.pathname === '/api/savings/suggestion') return json(route, { suggestion: null });
      if (url.pathname !== '/api/savings') return route.continue();
      const params = Object.fromEntries(url.searchParams);
      requests.push(params);
      try {
        assert.equal(url.searchParams.size, Object.keys(params).length, 'Duplicate query params');
        assert.deepEqual(Object.keys(params).sort(), params.cursor ? ['cursor', 'limit', 'status'] : ['limit', 'status']);
        assert.equal(params.limit, '20');
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
    assert.deepEqual(routeViolations, [], 'Unexpected savings query shape');
    assert.deepEqual(mutationAttempts, [], 'No post-login mutation may be invoked');
    // Exact fault allowlist: label/path/status/count; unrelated console/resource errors are never suppressed.
    const expectedHttp = errors.filter(error => error.label === fault.browserLabel && error.type === 'http' && error.path === fault.path && error.status === fault.status);
    const expectedConsole = errors.filter(error => error.label === fault.browserLabel && error.type === 'console' && error.path === fault.path && /^Failed to load resource: the server responded with a status of 503\b/.test(error.message));
    assert.equal(expectedHttp.length, fault.count, 'Expected exact 503 HTTP count');
    assert.equal(expectedConsole.length, fault.count, 'Expected exact matching resource-console count');
    assert.deepEqual(errors.filter(error => !expectedHttp.includes(error) && !expectedConsole.includes(error)), [], 'Unexpected browser errors');
  } catch (error) {
    failure = h.sanitize(error.message);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
    await h.writeResult({ suite: 'v12-savings-list', ok: !failure, passed, ...(failure ? { failure } : {}), requests,
      errors, expectedFault: fault, failedNextPages, mutationAttempts, routeViolations, limitations });
  }
  if (failure) console.error(failure);
  else console.log(`Completed ${passed.length} browser steps; evidence ${h.evidenceDir}. BankSavingsAction q remains pending.`);
}
