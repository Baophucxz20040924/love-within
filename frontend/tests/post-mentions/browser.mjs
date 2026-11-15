// Owned local mock API4002 / UI5175 only. No saved credentials, traces, HAR or provider calls.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const home = process.env.LW_PW_HOME || path.join(process.env.TEMP || process.env.TMP, 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `post-mentions-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const checks = [], errors = [], contexts = [];
let browser, activePage;
async function response(user, method, route, body) {
  return fetch(api + route, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function request(user, method, route, body) {
  const r = await response(user, method, route, body);
  assert.ok(r.ok, `${method} ${route.split('?')[0]} returned ${r.status}`);
  return (await r.json()).data;
}
const run = randomBytes(5).toString('hex');
async function account(suffix, name) {
  const email = `tag-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: name });
  const user = { email, password, token: auth.accessToken, name };
  await request(user, 'POST', '/friends/join', {});
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function session(user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__sse = [];
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const r = await original(...args);
      if (!String(args[0]).includes('/realtime?') || !r.ok || !r.body) return r;
      const decoder = new TextDecoder();
      return new Response(r.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        window.__sse.push(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk);
      } })), { status: r.status, headers: r.headers });
    };
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, delay, ...args) => interval(fn, [20000, 30000, 60000].includes(delay) ? 3600000 : delay, ...args);
  });
  const page = await context.newPage(); user.page = page;
  page.on('pageerror', e => errors.push(e.name));
  await page.goto(ui + '/login');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
  await page.waitForURL('**/friends/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(u => u.pathname === '/friends');
  await page.waitForFunction(() => window.__sse.some(x => x.includes('event: ready')));
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
async function shot(page, name) { await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, mask: [page.locator('input[type=email],input[type=password]')] }); }
async function edit(page, post) {
  await page.goto(`${ui}/friends/posts/${post.id}`);
  await page.getByRole('button', { name: 'Tùy chọn bài viết', exact: true }).click();
  await page.getByRole('button', { name: 'Chỉnh sửa bài viết', exact: true }).click();
  return page.getByLabel('Nội dung bài viết', { exact: true });
}
try {
  const a = await account('a', 'Tag Tác Giả'), b = await account('b', 'Bảo Nguyễn'), c = await account('c', 'Tag Ngoài');
  const invite = await request(a, 'POST', '/friends/requests', { userId: b.id });
  await request(b, 'POST', `/friends/requests/${invite.requestId}/accept`, {});
  browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true });
  await session(a); await session(b); activePage = a.page;
  await b.page.goto(ui + '/friends/notifications');
  let post;
  await check('Mobile composer searches accepted friends without accents, keeps focus and multiline, submits UTF-16 tags', async () => {
    await a.page.locator('.composer-prompt__input').click();
    const box = a.page.getByLabel('Nội dung bài viết', { exact: true });
    await box.fill('  🌻 Xin @bao');
    const option = a.page.getByRole('option', { name: b.name, exact: true });
    await option.waitFor();
    await box.press('Escape');
    assert.equal(await a.page.getByRole('dialog', { name: 'Tạo bài viết', exact: true }).isVisible(), true, 'Escape should dismiss picker before dialog');
    await box.fill('  🌻 Xin '); await box.pressSequentially('@bao'); await option.waitFor();
    await shot(a.page, 'composer-picker');
    await option.click();
    assert.equal(await box.evaluate(el => document.activeElement === el), true);
    await box.press('Enter'); await box.pressSequentially(`Cùng đi chơi ${run}`);
    assert.ok((await box.inputValue()).includes('\n'));
    assert.equal(await a.page.locator('.mention-field__mark').count(), 1);
    await shot(a.page, 'composer-selected-multiline');
    await a.page.getByRole('button', { name: 'Đăng', exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Tạo bài viết', exact: true }).waitFor({ state: 'hidden' });
    post = (await request(a, 'GET', '/friends/stories')).items.find(x => x.body.includes(run));
    assert.ok(post); assert.equal(post.mentions.length, 1); assert.equal(post.body.slice(post.mentions[0].offset, post.mentions[0].offset + post.mentions[0].length), `@${b.name}`);
    await a.page.locator('.post__body').getByRole('link', { name: '@' + b.name, exact: true }).waitFor();
  });
  let notification;
  await check('Recipient gets live post-specific notification without polling and opens the exact post', async () => {
    activePage = b.page;
    const item = b.page.locator('.notif').filter({ hasText: 'đã nhắc đến bạn trong một bài viết' });
    await item.waitFor({ timeout: 4000 }); await shot(b.page, 'notification-live');
    notification = (await request(b, 'GET', '/friends/notifications')).items.find(n => n.type === 'post_mention' && n.entity?.id === post.id);
    assert.ok(notification); assert.equal(notification.entity.kind, 'story');
    await item.click(); await b.page.waitForURL(`**/friends/posts/${post.id}`);
    await b.page.locator('.post__body a.mention').waitFor();
    await b.page.locator('.post__body a.mention').click(); await b.page.waitForURL(`**/friends/u/${b.id}`);
  });
  await check('Unrelated target cannot be tagged and tagging never grants post access', async () => {
    const text = `@${c.name}`;
    assert.equal((await response(a, 'POST', '/friends/stories', { body: text, photos: [], mentions: [{ userId: c.id, offset: 0, length: text.length }] })).status, 400);
    assert.equal((await response(c, 'GET', `/friends/stories/${post.id}`)).status, 404);
    const matches = await request(a, 'GET', '/friends/stories/mentionable?q=Tag');
    assert.ok(matches.every(x => x.id !== c.id && x.id !== a.id));
  });
  await check('Editing hydrates tags; prefix shifts preserve links and no duplicate notification/read churn', async () => {
    activePage = a.page;
    const box = await edit(a.page, post);
    assert.equal(await a.page.locator('.mention-field__mark').count(), 1);
    await box.press('Control+Home'); await box.pressSequentially('Chào ');
    await a.page.getByRole('button', { name: 'Lưu', exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Chỉnh sửa bài viết', exact: true }).waitFor({ state: 'hidden' });
    const updated = await request(a, 'GET', `/friends/stories/${post.id}`);
    assert.equal(updated.mentions[0].offset, post.mentions[0].offset + 5);
    const rows = (await request(b, 'GET', '/friends/notifications')).items.filter(n => n.type === 'post_mention' && n.entity?.id === post.id);
    assert.equal(rows.length, 1); assert.equal(rows[0].updatedAt, notification.updatedAt); assert.equal(rows[0].read, true);
    await shot(a.page, 'edited-post');
  });
  await check('Removing tag in UI removes notification live and keeps readable body', async () => {
    await b.page.goto(ui + '/friends/notifications');
    const item = b.page.locator('.notif').filter({ hasText: 'đã nhắc đến bạn trong một bài viết' }); await item.waitFor();
    const box = await edit(a.page, post);
    await box.fill(`Không nhắc tên nữa ${run}`);
    await a.page.getByRole('button', { name: 'Lưu', exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Chỉnh sửa bài viết', exact: true }).waitFor({ state: 'hidden' });
    await item.waitFor({ state: 'hidden', timeout: 4000 });
    assert.equal((await request(a, 'GET', `/friends/stories/${post.id}`)).mentions.length, 0);
  });
  await check('Re-adding a removed tag restores its live row without unread or push churn', async () => {
    const box = await edit(a.page, post);
    await box.fill(`Nhắc lại ${run} @bao`);
    await a.page.getByRole('option', { name: b.name, exact: true }).click();
    await a.page.getByRole('button', { name: 'Lưu', exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Chỉnh sửa bài viết', exact: true }).waitFor({ state: 'hidden' });
    await b.page.locator('.notif').filter({ hasText: 'đã nhắc đến bạn trong một bài viết' }).waitFor({ timeout: 4000 });
    const row = (await request(b, 'GET', '/friends/notifications')).items.find(n => n.type === 'post_mention' && n.entity?.id === post.id);
    assert.equal(row.updatedAt, notification.updatedAt); assert.equal(row.read, true);
  });
  await check('Existing comment tagging still selects and sends correctly', async () => {
    await a.page.goto(`${ui}/friends/posts/${post.id}`);
    const box = a.page.getByPlaceholder('Viết bình luận…');
    await box.fill('@bao'); await a.page.getByRole('option', { name: b.name, exact: true }).click();
    await a.page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
    await a.page.locator('.comment__body a.mention').waitFor();
    assert.equal((await request(a, 'GET', `/friends/stories/${post.id}/comments`))[0].mentions.length, 1);
    const rows = (await request(b, 'GET', '/friends/notifications')).items;
    assert.ok(rows.some(n => n.type === 'mention' && n.entity?.kind === 'comment' && n.entity.storyId === post.id));
  });
  await check('Poll/photo composer retains tag and Enter chooses suggestions by keyboard', async () => {
    await a.page.goto(ui + '/friends'); await a.page.locator('.composer-prompt__input').click();
    await a.page.getByRole('button', { name: 'Bình chọn', exact: true }).click();
    const box = a.page.getByLabel('Câu hỏi bình chọn', { exact: true });
    await box.fill('Đi đâu @bao'); await a.page.getByRole('option', { name: b.name, exact: true }).waitFor();
    await box.press('ArrowDown'); await box.press('Enter');
    await a.page.getByLabel('Lựa chọn 1', { exact: true }).fill('Cà phê'); await a.page.getByLabel('Lựa chọn 2', { exact: true }).fill('Đi bộ');
    await a.page.getByRole('dialog', { name: 'Tạo bài viết', exact: true }).locator('input[type=file]').setInputFiles({ name: 'tag.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    await a.page.getByRole('button', { name: 'Đăng', exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Tạo bài viết', exact: true }).waitFor({ state: 'hidden' });
    const p = (await request(a, 'GET', '/friends/stories')).items.find(x => x.poll);
    assert.ok(p); assert.equal(p.photos.length, 1); assert.equal(p.mentions.length, 1);
    await shot(a.page, 'poll-photo-tag');
  });
  await check('Blocked target disappears from search and explicit forged tag is rejected', async () => {
    // The suite intentionally drives many SSE refetches; allow the real per-user read budget to reset.
    await a.page.waitForTimeout(61_000);
    await request(a, 'POST', '/friends/blocks', { userId: b.id });
    assert.equal((await request(a, 'GET', '/friends/stories/mentionable?q=bao')).length, 0);
    assert.equal((await response(a, 'POST', '/friends/stories', { body: `@${b.name}`, photos: [], mentions: [{ userId: b.id, offset: 0, length: b.name.length + 1 }] })).status, 400);
    assert.equal((await request(b, 'GET', '/friends/notifications')).items.filter(n => n.type === 'post_mention').length, 0);
  });
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, scope: 'Local mobile emulation and mock providers; polling disabled. Not physical phone or Web Push delivery proof.' }, null, 2));
  console.log('Evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
  const failure = String(error?.message || 'Failure').split('\nCall log:')[0].replaceAll(/tag-[\w-]+@example\.test/g, '[synthetic email]');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, failure }, null, 2));
  console.error(failure); console.log('Evidence:', evidence); process.exitCode = 1;
} finally { for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); }
