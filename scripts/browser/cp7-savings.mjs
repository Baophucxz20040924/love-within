import {
  assert, baseURL, newCouple, seedBank, cleanupBank, login, openBrowser, fresh,
  screenshot, visible, absent, noOverflow, writeResult, evidenceDir, sanitize, runId,
} from './harness.mjs';

const checks = []; const errors = []; const sessions = [];
const expectedFaultResponses = [];
const faultWindows = [];
let browser; let couple; let bankAttempted = false; let failure; let goalPath;
const goalTitle = `Chuyến đi CP7 ${runId.slice(-6)}`;
const privateNote = `CP7 private bank note ${runId.slice(-6)}`;
async function step(name, fn) {
  try { await fn(); checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, ok: false }); throw new Error(`${name}: ${error.message}`, { cause: error }); }
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
async function go(page, route) { await page.goto(`${baseURL}${route}`); }
async function propose(page, target, due = '') {
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Mục tiêu (VND)', { exact: false }).fill(String(target));
  await sheet.getByLabel('Hạn (tuỳ chọn)', { exact: true }).fill(due);
  await sheet.getByRole('button', { name: 'Gửi đề xuất', exact: true }).click();
  await absent(sheet);
}
async function decide(page, approve = true) {
  await go(page, '/approvals');
  const action = button(page, approve ? 'Đồng ý' : 'Từ chối');
  await visible(action); // Fresh couple, exactly one pending proposal at a time.
  await action.click();
  await absent(action);
  await visible(page.getByText('Không có gì cần bạn duyệt', { exact: true }));
}
async function entry(page, amount, note, withdraw = false) {
  await button(page, withdraw ? 'Rút tiền' : 'Góp tiền').click();
  const sheet = dialog(page, withdraw ? 'Rút tiền' : 'Góp tiền');
  await sheet.getByLabel('Số tiền (VND)', { exact: true }).fill(String(amount));
  await sheet.getByLabel('Ghi chú', { exact: false }).fill(note);
  await sheet.getByRole('button', { name: withdraw ? 'Lưu khoản rút' : 'Lưu khoản góp', exact: true }).click();
  await absent(sheet);
  await visible(page.locator('article.savings-entry').filter({ hasText: note }));
}
function progress(page) { return page.getByRole('region', { name: 'Tiến độ quỹ', exact: true }); }
async function total(page, amount) {
  const text = new Intl.NumberFormat('vi-VN').format(amount);
  await visible(progress(page).locator('.savings-progress__amount').filter({ hasText: text }));
  const actual = await progress(page).locator('.savings-progress__amount').innerText();
  assert(actual.trim().startsWith(text), `Expected displayed total ${text}`);
}

try {
  browser = await openBrowser();
  couple = await newCouple();
  const owner = await fresh(browser, 'owner', errors);
  const partner = await fresh(browser, 'partner-reduced', errors, { reducedMotion: 'reduce' });
  sessions.push(owner, partner);
  const a = owner.page; const b = partner.page;

  await step('login two independent couple sessions through UI', async () => {
    await login(a, couple.a); await login(b, couple.b);
    assert(await b.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  });
  await step('finance exposes savings without any bank connection', async () => {
    await go(a, '/finance');
    await visible(a.getByText('Theo dõi dòng tiền của bạn', { exact: true }));
    await a.getByRole('link', { name: /Quỹ chung/ }).click();
    await a.waitForURL('**/savings');
    await visible(a.getByText('Chưa có quỹ chung', { exact: true }));
    await visible(a.getByText(/Không cần liên kết ngân hàng để góp thủ công/));
    await noOverflow(a); await screenshot(a, '01-no-bank-empty');
  });
  await step('create proposal, not an immediately active goal', async () => {
    await button(a, 'Tạo quỹ').click();
    const sheet = dialog(a, 'Đề xuất quỹ mới');
    assert(await sheet.getByRole('button', { name: 'Gửi đề xuất', exact: true }).isDisabled());
    await sheet.getByLabel('Tên quỹ', { exact: true }).fill(goalTitle);
    await propose(a, 1_000_000);
    await visible(a.getByText('Chưa có quỹ chung', { exact: true }));
    await go(a, '/approvals');
    await visible(a.locator('.approval').filter({ hasText: goalTitle }));
    assert.equal(await button(a, 'Đồng ý').count(), 0, 'Author must not self-approve');
    await screenshot(a, '02-outgoing-proposal');
  });
  await step('partner approves create and goal opens from list UI', async () => {
    await decide(b);
    await go(a, '/savings');
    await a.getByRole('link').filter({ has: a.getByRole('heading', { name: new RegExp(goalTitle) }) }).click();
    await visible(button(a, 'Góp tiền'));
    goalPath = new URL(a.url()).pathname;
    assert(/^\/savings\/[^/]+$/.test(goalPath));
    await total(a, 0); await screenshot(a, '03-active-goal');
  });
  await step('pin reaches home card without new navigation tab', async () => {
    await button(a, 'Ghim lên Trang chủ').click();
    await visible(button(a, 'Bỏ ghim'));
    await go(a, '/');
    const homeCard = a.getByRole('link', { name: `Quỹ chung: ${goalTitle}`, exact: true });
    await visible(homeCard); await screenshot(a, '04-home-pin'); await homeCard.click();
    await visible(button(a, 'Góp tiền'));
  });
  await step('manual entry keeps operationId and immutable payload after lost acknowledgement and busy retry', async () => {
    const attempts = [];
    const acknowledged = [];
    const routePattern = `**/api${goalPath}/entries`;
    const start = errors.length;
    await a.route(routePattern, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        // Let the real local mock-backed API commit, then hide only its acknowledgement.
        const response = await route.fetch();
        assert(response.ok(), `Initial entry must commit before lost-ack injection: ${response.status()}`);
        acknowledged.push(await response.json());
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_LOST_ACK', message: 'V12 controlled lost acknowledgement' } }) });
      } else if (attempts.length === 2) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SAVINGS_BUSY', message: 'V12 controlled busy retry' } }) });
      } else {
        const response = await route.fetch();
        assert(response.ok(), `Same-key replay must succeed: ${response.status()}`);
        acknowledged.push(await response.json());
        await route.fulfill({ response });
      }
    });
    try {
      await button(a, 'Góp tiền').click();
      const sheet = dialog(a, 'Góp tiền');
      await sheet.getByLabel('Số tiền (VND)', { exact: true }).fill('600000');
      await sheet.getByLabel('Ghi chú', { exact: false }).fill('CP7 góp của An');
      await sheet.getByRole('button', { name: 'Lưu khoản góp', exact: true }).click();
      const retry = sheet.getByRole('button', { name: 'Thử lại cùng yêu cầu', exact: true });
      await visible(retry);
      assert(await sheet.getByLabel('Số tiền (VND)', { exact: true }).isDisabled(), 'Uncertain amount must stay immutable');
      assert(await sheet.getByLabel('Ghi chú', { exact: false }).isDisabled(), 'Uncertain note must stay immutable');
      assert(await sheet.getByRole('button', { name: 'Đóng', exact: true }).isDisabled(), 'Uncertain sheet must not discard the key');
      await retry.click();
      await visible(sheet.getByRole('alert').filter({ hasText: 'Quỹ đang xử lý thay đổi khác' }));
      assert(await sheet.getByLabel('Số tiền (VND)', { exact: true }).isDisabled(), 'Busy after uncertainty must not unlock the draft');
      await screenshot(a, '03b-uncertain-busy-same-key');
      await retry.click(); await absent(sheet);
      assert.equal(attempts.length, 3, 'Expected initial write and two same-key retries');
      assert.match(attempts[0].operationId, /^[a-f\d-]{36}$/i);
      assert.deepEqual(attempts[1], attempts[0], 'Busy retry changed operationId or payload');
      assert.deepEqual(attempts[2], attempts[0], 'Replay changed operationId or payload');
      assert.equal(acknowledged.length, 2, 'Initial commit and final replay must have successful response bodies');
      assert(acknowledged[0].data?.entry?.id, 'Initial acknowledgement must identify the committed entry');
      assert.equal(acknowledged[1].data?.entry?.id, acknowledged[0].data.entry.id, 'Replay must return the same entry');
      assert.equal(acknowledged[1].data?.goal?.totalVnd, 600_000, 'Replay response must retain the exactly-once balance');
      const row = a.locator('article.savings-entry').filter({ hasText: 'CP7 góp của An' });
      await visible(row); assert.equal(await row.count(), 1, 'Replay must not duplicate entry');
      await total(a, 600_000);
      expectedFaultResponses.push('POST savings entry: committed acknowledgement replaced with 503, next retry synthetic SAVINGS_BUSY 409');
    } finally {
      faultWindows.push({ start, end: errors.length });
      await a.unroute(routePattern);
    }
  });
  await step('owner manually contributes without bank', async () => {
    // The preceding UI write committed exactly once despite its hidden acknowledgement.
    await total(a, 600_000);
    assert.equal(await a.locator('article.savings-entry').filter({ hasText: 'CP7 góp của An' }).count(), 1);
  });
  await step('partner sees contribution but cannot delete owner entry', async () => {
    await go(b, goalPath);
    const row = b.locator('article.savings-entry').filter({ hasText: 'CP7 góp của An' });
    await visible(row);
    assert.equal(await row.getByRole('button', { name: /^Xóa khoản/ }).count(), 0);
    await entry(b, 300_000, 'CP7 góp của Bình'); await total(b, 900_000);
  });
  await step('withdraw requires reason and recomputes total', async () => {
    await go(a, goalPath); await button(a, 'Rút tiền').click();
    const sheet = dialog(a, 'Rút tiền');
    await sheet.getByLabel('Số tiền (VND)', { exact: true }).fill('100000');
    assert(await sheet.getByRole('button', { name: 'Lưu khoản rút', exact: true }).isDisabled());
    await sheet.getByLabel('Ghi chú', { exact: false }).fill('CP7 rút để kiểm tra');
    await sheet.getByRole('button', { name: 'Lưu khoản rút', exact: true }).click();
    await absent(sheet); await total(a, 800_000); await screenshot(a, '05-contributions-withdraw');
  });
  await step('delete own withdrawal through confirmation recomputes total', async () => {
    const row = a.locator('article.savings-entry').filter({ hasText: 'CP7 rút để kiểm tra' });
    await row.getByRole('button', { name: /^Xóa khoản của tôi ngày/ }).click();
    await dialog(a, 'Xóa khoản ghi?').getByRole('button', { name: 'Xóa khoản này', exact: true }).click();
    await absent(dialog(a, 'Xóa khoản ghi?')); await absent(row); await total(a, 900_000);
  });
  await step('target proposal rejection keeps old target', async () => {
    await button(a, 'Đổi mục tiêu / hạn').click(); await propose(a, 1_200_000);
    await decide(b, false); await go(a, goalPath);
    await visible(progress(a).getByText(/1\.000\.000/));
  });
  await step('target and due-date changes require partner approval', async () => {
    const due = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    await button(a, 'Đổi mục tiêu / hạn').click(); await propose(a, 1_200_000, due);
    await decide(b); await go(a, goalPath);
    await visible(progress(a).getByText(/1\.200\.000/));
    await visible(progress(a).getByText(/^Hạn /));
  });
  await step('reaching goal honors reduced motion and offers memory actions', async () => {
    await go(b, goalPath); await entry(b, 300_000, 'CP7 chạm mục tiêu');
    await total(b, 1_200_000);
    await visible(b.getByText('Hai bạn đã từng chạm mục tiêu!', { exact: true }));
    assert.equal(await b.locator('.bk-party').count(), 0, 'Reduced-motion context must not render confetti');
    await visible(b.getByRole('link', { name: 'Thêm vào Bucket list', exact: true }));
    await visible(b.getByRole('link', { name: 'Viết kỷ niệm', exact: true }));
    await noOverflow(b); await screenshot(b, '06-reached-reduced-motion');
  });
  await step('milestone links open real bucket and story composers', async () => {
    await b.getByRole('link', { name: 'Thêm vào Bucket list', exact: true }).click();
    await b.waitForURL(url => url.pathname === '/quests/bucket');
    await visible(b.getByRole('dialog')); await screenshot(b, '07-bucket-composer');
    await go(b, goalPath);
    await b.getByRole('link', { name: 'Viết kỷ niệm', exact: true }).click();
    await b.waitForURL(url => url.pathname === '/stories');
    await visible(b.getByRole('dialog')); await screenshot(b, '08-story-composer');
  });
  await step('normal-motion milestone deduplicates after reload', async () => {
    await go(a, goalPath);
    await visible(a.getByText('Hai bạn đã từng chạm mục tiêu!', { exact: true }));
    // Reload should not replay the same event; reduced-motion is independently checked above.
    await a.reload(); await visible(button(a, 'Góp tiền'));
    assert.equal(await a.locator('.bk-party').count(), 0);
  });
  await step('seed mock bank only and save a private note through finance UI', async () => {
    bankAttempted = true; await seedBank(couple.a);
    await go(a, '/finance');
    await visible(a.getByText(/Chỉ mình bạn xem dòng tiền này/));
    await a.getByRole('button', { name: /^Tiền ra .*sửa ghi chú/ }).first().click();
    const sheet = dialog(a, 'Ghi chú giao dịch');
    await sheet.getByLabel('Ghi chú', { exact: false }).fill(privateNote);
    await sheet.getByRole('button', { name: 'Lưu ghi chú', exact: true }).click();
    await absent(sheet);
    await a.getByRole('button').filter({ hasText: privateNote }).click();
  });
  await step('bank attachment warns explicitly before sharing amount and date', async () => {
    const sheet = dialog(a, 'Ghi chú giao dịch');
    await sheet.getByRole('button', { name: 'Ghi là tiền góp quỹ…', exact: true }).click();
    await visible(sheet.getByText('Người ấy sẽ thấy số tiền và ngày của giao dịch này', { exact: true }));
    await visible(sheet.getByText(/Kể cả khi dòng tiền đang riêng tư/));
    assert(await sheet.getByRole('button', { name: 'Xác nhận góp quỹ', exact: true }).isDisabled());
    await sheet.getByLabel('Chọn quỹ', { exact: true }).selectOption({ value: goalPath.split('/').at(-1) });
    await absent(a.locator('.toast'));
    await sheet.getByRole('button', { name: 'Xác nhận góp quỹ', exact: true }).scrollIntoViewIfNeeded();
    await noOverflow(a); await screenshot(a, '09-bank-privacy-warning');
    await sheet.getByRole('button', { name: 'Xác nhận góp quỹ', exact: true }).click();
    await visible(sheet.getByText(/Đã ghi giao dịch vào quỹ\. Ghi chú của bạn không được sao chép/));
    await sheet.getByRole('button', { name: 'Đóng', exact: true }).click();
    await visible(a.getByText(/Chỉ mình bạn xem dòng tiền này/));
  });
  await step('partner sees bank contribution, never the private bank note', async () => {
    await go(b, goalPath);
    await visible(b.getByText(/Từ giao dịch ngân hàng/));
    assert.equal(await b.getByText(privateNote, { exact: true }).count(), 0);
    const row = b.locator('article.savings-entry').filter({ hasText: 'Từ giao dịch ngân hàng' });
    assert.equal(await row.getByRole('button').count(), 0);
    await screenshot(b, '10-shared-ledger-no-private-note');
  });
  await step('close proposal leaves goal editable until approved', async () => {
    await go(a, goalPath); await button(a, 'Đóng quỹ').click();
    await dialog(a, 'Đề xuất đóng quỹ').getByRole('button', { name: 'Gửi đề xuất', exact: true }).click();
    await absent(dialog(a, 'Đề xuất đóng quỹ')); await visible(button(a, 'Góp tiền'));
    await decide(b);
  });
  await step('approved closure is read-only for both and unpins home', async () => {
    for (const page of [a, b]) {
      await go(page, goalPath);
      await visible(page.getByText(/Quỹ đã đóng, chỉ xem lại lịch sử/));
      assert.equal(await button(page, 'Góp tiền').count(), 0);
      assert.equal(await button(page, 'Rút tiền').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Xóa khoản của tôi/ }).count(), 0);
      await noOverflow(page);
    }
    await screenshot(a, '11-closed-read-only');
    await go(a, '/');
    await visible(a.getByRole('navigation'));
    assert.equal(await a.getByRole('link', { name: `Quỹ chung: ${goalTitle}`, exact: true }).count(), 0);
    await go(a, '/savings');
    await a.getByRole('radio', { name: 'Đã đóng', exact: true }).click();
    await visible(a.getByRole('heading', { name: new RegExp(goalTitle) }));
    await screenshot(a, '12-closed-list');
  });
  await step('browser has no unexpected console, page, failed request or HTTP errors', async () => {
    const expectedPath = `/api${goalPath}/entries`;
    const expected = new Map([['http|503', 1], ['http|409', 1], ['console|503', 1], ['console|409', 1]]);
    const unexpected = errors.filter((error, index) => {
      const controlled = faultWindows.some(window => index >= window.start && index < window.end);
      if (!controlled || error.label !== 'owner' || error.path !== expectedPath) return true;
      const status = error.type === 'http' ? error.status
        : error.type === 'console' ? /^Failed to load resource: the server responded with a status of (409|503)(?: \([^\r\n]*\))?$/.exec(error.message)?.[1] : null;
      const key = `${error.type}|${status}`, remaining = expected.get(key) ?? 0;
      if (!remaining) return true;
      expected.set(key, remaining - 1); return false;
    });
    assert.deepEqual([...expected].filter(([, count]) => count), [], 'Expected controlled resource errors must each occur exactly once');
    assert.equal(errors.filter(error => error.type === 'http' && error.path === expectedPath && error.status === 503).length, 1, 'Exactly one controlled lost acknowledgement required');
    assert.equal(errors.filter(error => error.type === 'http' && error.path === expectedPath && error.status === 409).length, 1, 'Exactly one controlled busy retry required');
    assert.deepEqual(unexpected, [], 'See sanitized browser errors in result.json');
  });
} catch (error) {
  failure = sanitize(error.message);
  console.error(`FAIL ${failure}`);
  for (const [i, session] of sessions.entries()) {
    try { await screenshot(session.page, `failure-session-${i + 1}`); } catch { /* browser may already be unavailable */ }
  }
} finally {
  if (bankAttempted && couple) {
    try { await cleanupBank(couple.a); }
    catch (error) { failure ||= `Bank cleanup failed: ${sanitize(error.message)}`; checks.push({ name: 'mock bank cleanup', ok: false }); }
  }
  if (browser) await browser.close();
  const passed = checks.filter(check => check.ok).length;
  const result = { suite: 'cp7-savings-ui', viewport: '360x780', locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh', passed, total: checks.length, ok: !failure, checks, errors, expectedFaultResponses, limitations: ['Lost acknowledgement is browser-injected after an observed successful local API response; not real process crash/journal proof', 'Same-key retry persists only while the sheet remains mounted, not across reload'], ...(failure ? { failure } : {}) };
  await writeResult(result);
  console.log(`TOTAL ${passed}/${checks.length}; ${failure ? 'FAIL' : 'PASS'}; evidence: ${evidenceDir}`);
  if (failure) process.exitCode = 1;
}
