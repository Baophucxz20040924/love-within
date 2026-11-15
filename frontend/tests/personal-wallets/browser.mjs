// AUTHOR-ONLY browser verification for an already-running, owned mock API (4002) and UI (5175).
// Requires --local-mock-runtime and external playwright-core in LW_PW_HOME. Never starts services.
// Creates two synthetic accounts; does not read .env, access providers, persist credentials or clean DB fixtures.
// Screenshots are masked. This is not a Mongo legacy migration, concurrency, multiworker, or production test.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw Error('Explicit local mock opt-in required');
const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api', ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `personal-wallets-${Date.now()}`);
const run = randomBytes(5).toString('hex');
const contexts = [], pageErrors = [];
let browser, activePage;

async function response(user, method, route, body) {
  // All requests are pinned to localhost and only authenticated as accounts created by this run.
  if (user) assert.equal(user.syntheticRun, run);
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
  const email = `wallet-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: name });
  const user = { syntheticRun: run, email, password, token: auth.accessToken };
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function session(user) {
  assert.equal(user.syntheticRun, run);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(`${ui}/login`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/', { timeout: 20_000 });
  return page;
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const radio = (page, name) => page.getByRole('radio', { name, exact: true });
async function shot(page, name) {
  activePage = page;
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false, animations: 'disabled', mask: [page.locator('input, textarea')] });
}
async function wallets(buyer, seller) {
  const [a, b] = await Promise.all([request(buyer, 'GET', '/wallet'), request(seller, 'GET', '/wallet')]);
  assert.equal(a.ownerUserId, buyer.id); assert.equal(b.ownerUserId, seller.id);
  assert.equal(a.exp, b.exp); assert.equal(a.level, b.level);
  return [a.coinBalance, b.coinBalance];
}
async function balanceChip(page, n) {
  await page.getByLabel(`Ví Xu của bạn: ${n} Xu`, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
}
async function postItem(page, title, price) {
  activePage = page;
  await page.goto(`${ui}/market`);
  await radio(page, 'Gian hàng tôi').click();
  await button(page, 'Đăng món mới').click();
  const sheet = page.getByRole('dialog', { name: 'Đăng món vào gian hàng', exact: true });
  await sheet.getByLabel('Tên món', { exact: true }).fill(title);
  await sheet.getByLabel('Giá (Xu)', { exact: true }).fill(String(price));
  const waiting = page.waitForResponse(r => r.url().endsWith('/market/items') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Đăng món', exact: true }).click();
  const res = await waiting; assert.equal(res.status(), 201);
  await sheet.waitFor({ state: 'hidden' });
  return (await res.json()).data;
}
async function redeem(page, item, title) {
  activePage = page;
  await page.goto(`${ui}/market`);
  await page.getByRole('button').filter({ hasText: title }).click();
  const sheet = page.getByRole('dialog', { name: title, exact: true });
  await sheet.getByRole('button', { name: 'Đổi món này', exact: true }).click();
  const waiting = page.waitForResponse(r => r.url().endsWith(`/market/items/${item.id}/redeem`) && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Gửi yêu cầu', exact: true }).click();
  const res = await waiting, sent = res.request().postDataJSON();
  assert.match(sent.requestKey, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i, 'browser sends UUIDv4 request key');
  assert.equal(res.status(), 201);
  return (await res.json()).data.redemption;
}
async function sellerDecision(page, title, decision, id) {
  activePage = page;
  await page.goto(`${ui}/approvals`);
  const card = page.locator('.approval').filter({ hasText: title });
  const action = decision === 'decline' ? 'Từ chối' : 'Nhận lời';
  const waiting = page.waitForResponse(r => r.url().endsWith(`/market/redemptions/${id}/${decision}`) && r.request().method() === 'POST');
  await card.getByRole('button', { name: action, exact: true }).click();
  if (decision === 'decline') await page.getByRole('dialog', { name: 'Từ chối yêu cầu?', exact: true }).getByRole('button', { name: 'Từ chối', exact: true }).click();
  const res = await waiting; assert.ok(res.ok(), `${decision} failed: ${res.status()}`);
  assert.equal((await res.json()).data.status, decision === 'decline' ? 'declined' : 'accepted');
}
async function buyerAction(page, title, id, action) {
  activePage = page;
  // A fresh navigation ensures the selected redemption is fetched, without assuming SSE timing.
  await page.goto(`${ui}/market`);
  await page.getByRole('radio', { name: /^Đã đổi/ }).click();
  const card = page.locator('.redemption').filter({ hasText: title });
  const waiting = page.waitForResponse(r => r.url().endsWith(`/market/redemptions/${id}/${action}`) && r.request().method() === 'POST');
  await card.getByRole('button', { name: action === 'cancel' ? 'Rút lại' : 'Đã thực hiện', exact: true }).click();
  const res = await waiting; assert.ok(res.ok(), `${action} failed: ${res.status()}`);
  assert.equal((await res.json()).data.status, action === 'cancel' ? 'cancelled' : 'fulfilled');
}

try {
  await mkdir(evidence, { recursive: true });
  const buyer = await account('buyer', 'Ví An'), seller = await account('seller', 'Ví Bình');
  const invite = await request(buyer, 'POST', '/pairing/invite', { toEmail: seller.email });
  await request(seller, 'POST', `/pairing/invites/${invite.id}/accept`, {});
  assert.deepEqual(await wallets(buyer, seller), [0, 0]);
  await request(buyer, 'POST', '/checkin', {});
  const [fundedBuyer, emptySeller] = await wallets(buyer, seller);
  assert.ok(fundedBuyer >= 2, 'fixture needs funds remaining after one fulfilled purchase'); assert.equal(emptySeller, 0, 'buyer check-in does not credit partner');
  const price = 1, low = `Ví thấp ${run}`, costly = `Ví thiếu ${run}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: process.env.LW_HEADED !== '1' });
  const buyerPage = await session(buyer), sellerPage = await session(seller);
  await buyerPage.goto(`${ui}/market`); await sellerPage.goto(`${ui}/market`);
  await balanceChip(buyerPage, fundedBuyer); await balanceChip(sellerPage, 0);
  await shot(buyerPage, 'buyer-wallet'); await shot(sellerPage, 'seller-wallet');
  console.log('PASS different personal balances visible after one member checks in; shared EXP agrees');

  const lowItem = await postItem(sellerPage, low, price);
  const first = await redeem(buyerPage, lowItem, low);
  assert.equal(first.status, 'requested'); assert.deepEqual(await wallets(buyer, seller), [fundedBuyer - price, 0]);
  await balanceChip(buyerPage, fundedBuyer - price); await shot(buyerPage, 'purchase-held');
  await sellerDecision(sellerPage, low, 'decline', first.id);
  assert.deepEqual(await wallets(buyer, seller), [fundedBuyer, 0]);
  // Buyer stays on the already-mounted market page: observe dirty-event refetch, not a reload.
  await balanceChip(buyerPage, fundedBuyer);
  await shot(sellerPage, 'seller-declined');
  console.log('PASS UI request UUID, buyer-only debit, seller decline refund and mounted buyer balance refresh');

  const second = await redeem(buyerPage, lowItem, low);
  assert.deepEqual(await wallets(buyer, seller), [fundedBuyer - price, 0]);
  await buyerAction(buyerPage, low, second.id, 'cancel');
  assert.deepEqual(await wallets(buyer, seller), [fundedBuyer, 0]);
  console.log('PASS buyer cancel refunds only buyer');

  const third = await redeem(buyerPage, lowItem, low);
  await sellerDecision(sellerPage, low, 'accept', third.id);
  await buyerAction(buyerPage, low, third.id, 'fulfill');
  assert.deepEqual(await wallets(buyer, seller), [fundedBuyer - price, 0]);
  console.log('PASS accepted and fulfilled purchase consumes coins without crediting seller');

  // Reverse seller/buyer: the first buyer still has coins, but the other has none.
  const costlyItem = await postItem(buyerPage, costly, 1);
  await sellerPage.goto(`${ui}/market`);
  await sellerPage.getByRole('button').filter({ hasText: costly }).click();
  const sheet = sellerPage.getByRole('dialog', { name: costly, exact: true });
  assert.equal(await sheet.getByRole('button', { name: /Còn thiếu 1 Xu/ }).isDisabled(), true);
  await shot(sellerPage, 'insufficient-personal-wallet');
  const denied = await response(seller, 'POST', `/market/items/${costlyItem.id}/redeem`, { requestKey: randomUUID() });
  assert.equal(denied.status, 422, 'server refuses spending partner balance');
  assert.deepEqual(await wallets(buyer, seller), [fundedBuyer - price, 0]);
  console.log('PASS zero-balance member cannot spend the partner’s balance in UI or API');

  const [buyerLedger, sellerLedger] = await Promise.all([request(buyer, 'GET', '/ledger?type=coin'), request(seller, 'GET', '/ledger?type=coin')]);
  assert.ok(buyerLedger.length > 0);
  assert.ok(buyerLedger.every(row => row.scope === 'personal' && row.ownerUserId === buyer.id));
  assert.ok(sellerLedger.every(row => row.scope === 'personal' && row.ownerUserId === seller.id));
  assert.ok(buyerLedger.some(row => row.reason === 'checkin' && row.delta > 0));
  assert.equal(buyerLedger.filter(row => row.reason === 'market_purchase' && row.delta === -price).length, 3);
  assert.equal(buyerLedger.filter(row => row.reason === 'market_refund' && row.delta === price).length, 2);
  assert.equal(sellerLedger.length, 0);
  assert.deepEqual(pageErrors, []);
  console.log('PASS personal coin ledgers are owner-scoped; local synthetic fixtures only; evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, mask: [activePage.locator('input, textarea')] }).catch(() => {});
  console.error(String(error?.message || 'Failure').split('\nCall log:')[0].replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]').replace(/Bearer\s+\S+/gi, '[redacted]'));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
