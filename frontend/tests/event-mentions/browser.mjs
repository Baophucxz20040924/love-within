// Owned API4002/UI5175 only. Synthetic fixtures, no secrets or browser storage saved.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw Error('Explicit local mock opt-in required');
const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `event-mentions-${Date.now()}`);
const run = randomBytes(5).toString('hex'), contexts = [], pageErrors = [];
let browser, activePage;
async function response(user, method, route, body) {
  return fetch(api + route, { method, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function request(user, method, route, body) {
  const res = await response(user, method, route, body);
  assert.ok(res.ok, `${method} ${route.replace(/[a-f\d]{24}/g, '[id]')} returned ${res.status}`);
  return (await res.json()).data;
}
async function account(suffix, name) {
  const email = `event-mentions-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: name });
  const user = { email, password, token: auth.accessToken, name };
  await request(user, 'POST', '/friends/join', {});
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function friends(a, b) {
  const invitation = await request(a, 'POST', '/friends/requests', { userId: b.id });
  await request(b, 'POST', `/friends/requests/${invitation.requestId}/accept`, {});
}
async function session(user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(ui + '/login');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
  await page.waitForURL('**/friends/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/friends');
  return page;
}
async function shot(page, name) {
  await page.locator('.fev-discussion').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false, animations: 'disabled', mask: [page.locator('input, textarea')] });
}
try {
  await mkdir(evidence, { recursive: true });
  const a = await account('a', 'Kèo An'), b = await account('b', 'Kèo Bình'), c = await account('c', 'Kèo Chi');
  await friends(a, b); await friends(a, c); // B and C are intentionally not friends.
  const event = await request(a, 'POST', '/friends/events', { title: `Kèo thử tag ${run}`,
    startAt: new Date(Date.now() + 86_400_000).toISOString(), inviteeIds: [b.id, c.id] });
  await request(c, 'PUT', `/friends/events/${event.id}/rsvp`, { status: 'declined' });
  const root = await request(c, 'POST', `/friends/events/${event.id}/comments`, { body: 'Hẹn mọi người lần sau nhé' });
  const picked = await request(b, 'GET', `/friends/events/${event.id}/mentionable?q=Chi`);
  assert.deepEqual(picked.map(x => x.id), [c.id]);
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: process.env.LW_HEADED !== '1' });
  const page = await session(b);
  await page.goto(`${ui}/friends/events/${event.id}`);
  const input = page.getByRole('textbox', { name: 'Viết bình luận', exact: true });
  await input.fill('@Chi');
  await page.getByRole('option', { name: c.name, exact: true }).waitFor();
  await shot(page, 'picker-declined-guest');
  await page.getByRole('option', { name: c.name, exact: true }).click();
  const postResponse = page.waitForResponse(r => r.url().endsWith(`/events/${event.id}/comments`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  const saved = await (await postResponse).json();
  assert.equal(saved.data.mentions[0].userId, c.id);
  await page.locator('.comment__body a.mention').filter({ hasText: c.name }).waitFor();
  console.log('PASS event picker tags non-friend guest with declined RSVP and persists linked root');
  const comment = page.locator(`#comment-${root.id}`);
  await comment.getByRole('button', { name: 'Trả lời', exact: true }).click();
  assert.equal(await input.inputValue(), `@${c.name} `);
  await input.press('End'); await input.pressSequentially('Nhớ gặp lại nhé');
  const replyResponse = page.waitForResponse(r => r.url().endsWith(`/events/${event.id}/comments`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Gửi bình luận', exact: true }).click();
  const reply = await (await replyResponse).json();
  assert.equal(reply.data.parentId, root.id); assert.equal(reply.data.mentions[0].userId, c.id);
  await shot(page, 'linked-reply');
  console.log('PASS reply prefill sends structured event mention');
  await request(c, 'POST', '/friends/blocks', { userId: b.id });
  const hidden = await request(b, 'GET', `/friends/events/${event.id}/mentionable?q=Chi`);
  assert.deepEqual(hidden, []);
  const rejected = await response(b, 'POST', `/friends/events/${event.id}/comments`, { body: `@${c.name}`, mentions: [{ userId: c.id, offset: 0, length: c.name.length + 1 }] });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'MENTION_NOT_ALLOWED');
  await page.waitForFunction(() => document.querySelectorAll('.comment__body a.mention').length === 0);
  console.log('PASS realtime block revocation clears rendered mention links without reload');
  await page.reload(); await input.waitFor();
  assert.equal(await page.locator('.comment__body a.mention').count(), 0);
  await input.fill('@Chi');
  await page.getByText('Không có thành viên kèo phù hợp.', { exact: true }).waitFor();
  await shot(page, 'blocked-guest-plain-text');
  console.log('PASS bilateral block removes picker results and retained mention links');
  await request(a, 'DELETE', `/friends/${b.id}`);
  assert.equal((await response(b, 'GET', `/friends/events/${event.id}/mentionable?q=`)).status, 404);
  await page.getByText('Kèo không còn nữa', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Viết bình luận', exact: true }).count(), 0);
  console.log('PASS creator friendship revocation closes discussion and denies picker');
  assert.deepEqual(pageErrors, []);
  console.log('PASS event mention local browser suite; screenshots:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input, textarea')] }).catch(() => {});
  console.error(String(error?.message || 'Failure').split('\nCall log:')[0].replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]'));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
