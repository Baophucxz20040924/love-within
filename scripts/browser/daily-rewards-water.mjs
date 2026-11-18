// Mock-only UI verification. Operator owns Vite; this script never starts a server,
// installs dependencies, reads .env/baseline credentials, or contacts an API/provider.
// Run: node scripts/browser/daily-rewards-water.mjs [--validate]
// External tooling/browser/evidence overrides are the same as harness.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const fixedTime = '2026-11-18T02:10:00.000Z';
const localDate = '2026-11-18';
const id = n => n.toString(16).padStart(24, '0');
// Opaque colored fixture makes decoded preview/evidence unmistakable in screenshots.
// Generate PNG with Node built-ins; no image dependency, remote asset or metadata.
function proofPng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type), content = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const width = 120, height = 160, header = Buffer.alloc(13), rows = Buffer.alloc(height * (1 + width * 3));
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    const color = x >= 30 && x < 90 && y >= 30 && y < 140 ? (y > 65 ? [18, 128, 178] : [220, 241, 249]) : [246, 222, 229];
    rows.set(color, offset);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const imageBytes = proofPng();
const imageFile = { name: 'synthetic-proof.png', mimeType: 'image/png', buffer: imageBytes };
export const selectors = {
  checkin: 'Điểm danh hôm nay', claim: 'Nhận EXP', capture: 'Chụp ngay',
  composer: 'Khoảnh khắc của bạn', post: 'Đăng', reconcile: 'Kiểm tra lại',
  manual: 'Nhập thủ công', waterSheet: 'Nhập lượng nước', attachment: 'Chọn ảnh minh chứng',
  preview: 'Ảnh minh chứng đã xử lý', approval: 'Xác nhận', history: 'Lịch sử Xu / EXP',
};
export function fixtures() {
  const users = ['An', 'Bình'].map((displayName, i) => ({ id: id(i + 1), displayName, email: `daily-${i}@example.test`, avatarUrl: null, coupleId: id(3), timezone: 'Asia/Ho_Chi_Minh' }));
  const couple = { id: id(3), memberIds: users.map(u => u.id), members: users, anniversaryDate: '2026-01-01', daysInLove: 322, nextMilestone: { days: 365, remaining: 43 }, lastMilestone: 300, level: 2, exp: 125, timezone: 'Asia/Ho_Chi_Minh' };
  const target = { localDate, sessionId: 'daily-2026-11-18' };
  const reward = { policyVersion: 2, effectiveDate: localDate, localDate, status: 'waiting', baseCoin: 0, bonusCoin: 0, coinAwarded: 0, commonStreak: 3 };
  const session = { ...target, legacy: false, scheduleVersion: 3, state: 'open', promptAt: '2026-11-18T02:00:00.000Z', windowEndsAt: '2026-11-18T02:30:00.000Z', rewardEndsAt: '2026-11-18T02:30:00.000Z', closesAt: '2026-11-18T17:00:00.000Z', closed: false, mine: null, partner: { posted: true, postedAt: fixedTime, photo: null }, storyId: null, reward };
  const photo = { url: '/__daily_mock__/photo.png', width: 120, height: 160, caption: 'Ảnh synthetic riêng tư', postedAt: fixedTime, lateMin: 0 };
  const quest = { key: 'duo_moment', type: 'duo_moment', title: 'Khoảnh khắc đôi', description: 'Xu ảnh tự cộng; nhiệm vụ chỉ nhận EXP.', coinReward: 0, expReward: 5, progress: 1, target: 1, status: 'completed', localDate, rewardPolicy: { version: 2, effectiveDate: localDate, timezone: 'Asia/Ho_Chi_Minh' } };
  const ledger = [
    ['checkin', 'checkin_pair', 'coin', 7, 5, 2],
    ['checkin', 'checkin_exp', 'exp', 5, 0, 0],
    ['moment', 'photo_base', 'coin', 10, 10, 0],
    ['moment', 'timely_pair_bonus', 'coin', 10, 0, 10],
    ['quest', 'quest_exp', 'exp', 5, 0, 0],
  ].map(([source, component, type, delta, baseCoin, bonusCoin], n) => ({
    id: id(200 + n), type, delta, balanceAfter: 100 + n, reason: source, refId: null,
    actorUserId: users[0].id, ownerUserId: type === 'coin' ? users[0].id : null,
    scope: type === 'coin' ? 'personal' : 'shared_exp', createdAt: fixedTime,
    provenance: { version: 1, source, component, localDate, policyVersion: 2, baseCoin, bonusCoin, ...(component === 'checkin_pair' ? { commonStreak: 3 } : {}) },
  }));
  return { users, couple, target, reward, session, photo, quest, ledger };
}
export function validate() {
  const f = fixtures();
  assert.equal(f.users.length, 2); assert.notEqual(f.users[0].id, f.users[1].id);
  assert.deepEqual(f.couple.memberIds, f.users.map(u => u.id));
  assert(Date.parse(f.session.promptAt) < Date.parse(fixedTime));
  assert(Date.parse(fixedTime) < Date.parse(f.session.rewardEndsAt));
  assert(Date.parse(f.session.rewardEndsAt) < Date.parse(f.session.closesAt));
  assert.equal(f.session.partner.photo, null); assert.equal(f.session.mine, null);
  assert.equal(f.quest.coinReward, 0); assert.equal(f.quest.expReward, 5);
  assert.equal(f.reward.policyVersion, 2); assert.equal(f.quest.rewardPolicy.version, 2);
  assert.equal(f.ledger.length, 5); assert(f.ledger.every(e => e.provenance.source === e.reason));
  assert(f.ledger.filter(e => e.type === 'coin').every(e => e.delta === e.provenance.baseCoin + e.provenance.bonusCoin));
  assert(imageBytes.length > 0);
  return true;
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(check, label, timeout = 12000) {
  const start = Date.now();
  while (!await check()) { assert(Date.now() - start < timeout, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 40)); }
}

async function main() {
  validate();
  // Intentionally before harness/Playwright import: works with no installed tooling or running app.
  if (process.argv.includes('--validate')) { console.log('PASS daily-rewards-water deterministic fixture invariants; no browser/network imported'); return; }
  process.env.LW_EVIDENCE_DIR ||= path.join(process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw'), 'shots', `daily-rewards-water-${Date.now()}`);
  const h = await import('./harness.mjs');
  const f = fixtures(), checks = [], inventory = [], errors = [], faults = [], blocked = [], requests = [];
  const states = f.users.map(() => ({ checked: false, claimed: false, mode: 'normal', saved: false, posts: 0, uploads: 0, monthReads: 0, heldReads: 0 }));
  const hold = gate(), stream = gate();
  const water = { log: null, uploads: 0, puts: 0, manuals: 0, approvals: 0, evidenceReads: 0 };
  let browser, stage = 'startup', closing = false;
  const clients = [];
  const limitations = [
    'Only browser/UI behavior against intercepted deterministic DTOs; no backend persistence, ACL, reward accounting, DB, AI, storage or push-provider proof.',
    'Two contexts, 360x780, vi-VN, Asia/Ho_Chi_Minh, fixed wall clock. Partner uses reduced motion.',
    'Foreign-session reconciliation is tested; actual account switching/PIN unlock during an in-flight post is not tested.',
    'Screenshots require manual visual review; native phone camera, real mobile OS and live HTTPS are not tested.',
  ];
  const wallet = i => ({ ownerUserId: f.users[i].id, coinBalance: 100 + (states[i].checked ? 7 : 0), exp: 125 + (states[i].claimed ? 5 : 0), level: 2, levelBaseExp: 100, nextLevelExp: 200 });
  const day = (i, foreign = false) => ({ localDate, legacy: false, scheduleVersion: 3, reward: f.reward, sessions: [
    { ...f.session, ...(states[i].saved ? { state: 'both', mine: f.photo, partner: { posted: true, postedAt: fixedTime, photo: f.photo } } : {}) },
    ...(foreign ? [{ ...f.session, sessionId: 'different-session-must-not-confirm', state: 'posted', mine: f.photo, partner: { posted: false, postedAt: null, photo: null } }] : []),
  ] });
  const waterToday = i => {
    const logs = water.log?.userId === f.users[i].id ? [water.log] : [];
    const totalMl = logs.filter(l => l.status === 'approved').reduce((n, l) => n + l.amountMl, 0);
    const pendingMl = logs.filter(l => l.status === 'pending').reduce((n, l) => n + l.amountMl, 0);
    return { localDate, totalMl, pendingMl, goalMl: 2000, goalMet: totalMl >= 2000, remainingMl: Math.max(0, 2000 - totalMl), logs, pendingGoalProposal: false };
  };
  const json = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  async function mock(route, i) {
    const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method(), s = states[i];
    // Never allow any origin (including loopback backend ports) other than the owned Vite origin.
    if (url.origin !== h.baseURL) { blocked.push({ label: i, method, path: p, reason: 'non-Vite origin' }); return route.abort('blockedbyclient'); }
    if (p === '/__daily_mock__/photo.png' && method === 'GET') return route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
    if (p.startsWith('/__daily_mock__/upload/') && method === 'PUT') {
      assert(request.postDataBuffer()?.length > 0, 'Upload must contain image bytes');
      if (p === '/__daily_mock__/upload/water') { assert.equal(request.headers()['content-type'], 'image/jpeg'); water.puts++; }
      else assert.equal(p, `/__daily_mock__/upload/moment-${i}`);
      return route.fulfill({ status: 200, body: '' });
    }
    if (p === '/api' || p.startsWith('/api/')) {
      requests.push({ label: i, method, path: p }); // Never record query strings, headers, tokens or request bodies.
      if (method === 'GET') {
        if (p === '/api/me') return json(route, { user: f.users[i], couple: f.couple, wallet: wallet(i), level: 2, exp: wallet(i).exp });
        if (p === '/api/privacy-lock') return json(route, { couple: false, friends: false, revision: 1 });
        if (p === '/api/couple') return json(route, f.couple);
        if (p === '/api/couple/pulse') return json(route, { question: null, letters: null, nextEvent: null, nudges: null, moods: { mine: null, partner: null }, savings: null, moment: { ...f.target, scheduleVersion: 3, state: s.saved ? 'both' : 'open', windowEndsAt: f.session.windowEndsAt, rewardEndsAt: f.session.rewardEndsAt, closesAt: f.session.closesAt, partnerPosted: true, reward: f.reward } });
        if (p === '/api/wallet') return json(route, wallet(i));
        if (p === '/api/checkin') return json(route, { localDate, checkedInToday: s.checked, streak: 3, partnerCheckedIn: true, reward: { ...f.reward, status: s.checked ? 'awarded' : 'waiting', baseCoin: 5, bonusCoin: s.checked ? 2 : 0, coinAwarded: s.checked ? 7 : 0, commonStreak: s.checked ? 3 : null } });
        if (p === '/api/quests/today') return json(route, [{ ...f.quest, status: s.claimed ? 'rewarded' : 'completed' }]);
        if (p === '/api/water/today') return json(route, waterToday(i));
        if (p === '/api/water/pending') return json(route, water.log?.status === 'pending' ? [{ ...water.log, submitterName: f.users[0].displayName }] : []);
        if (p === '/api/proposals' && url.searchParams.get('status') === 'pending') return json(route, []);
        if (p === '/api/market/redemptions/pending') return json(route, []);
        if (p === '/api/market/unread-count') return json(route, { count: 0, responded: 0, newItems: 0 });
        if (p === '/api/stories/unread-count') return json(route, { count: 0, stories: 0, comments: 0 });
        if (p === '/api/notifications/unread') return json(route, { notifications: 0, notificationsSaturated: false });
        if (p === '/api/notifications' && !url.search) return json(route, { items: [], nextCursor: null, watermark: '' });
        if (p === '/api/bucket') return json(route, { items: [], counts: { todo: 0, done: 0 } });
        if (p === '/api/push/config') return json(route, { enabled: false, publicKey: null, vapidPublicKey: null });
        if (p === '/api/finance/connection') return json(route, { linked: false, status: null, bankBrand: null, accountLast4: null, lastSuccessAt: null, lastError: null, visibility: 'private' });
        if (p === '/api/realtime' && url.searchParams.get('space') === 'couple') { await stream.promise; if (!closing) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': mock-only\n\n' }); return; }
        if (p === '/api/moments' || p === '/api/moments/today') {
          if (p === '/api/moments') { assert.equal(url.searchParams.get('month'), localDate.slice(0, 7)); s.monthReads++; }
          if (s.mode === 'receipt-held' && s.saved) { s.heldReads++; await hold.promise; if (closing) return; }
          const value = day(i, s.mode === 'foreign');
          return json(route, p === '/api/moments/today' ? value : { month: localDate.slice(0, 7), today: localDate, minMonth: localDate.slice(0, 7), days: [value], streak: { current: 3, best: 3 } });
        }
        if (water.log && p === `/api/water/logs/${water.log.id}/image-url`) { water.evidenceReads++; return json(route, { url: `${h.baseURL}/__daily_mock__/photo.png`, expiresIn: 300 }); }
        if (p === '/api/ledger') return json(route, f.ledger.map(entry => ({ ...entry, actorUserId: f.users[i].id, ownerUserId: entry.type === 'coin' ? f.users[i].id : null })));
      }
      if (method === 'POST') {
        const body = request.postData() ? request.postDataJSON() : {};
        if (p === '/api/checkin') { assert(!s.checked, 'No duplicate check-in'); s.checked = true; return json(route, { localDate, streak: 3, coinAwarded: 7, expAwarded: 5, leveledUp: false, reward: { ...f.reward, status: 'awarded', baseCoin: 5, bonusCoin: 2, commonStreak: 3, coinAwarded: 7 } }); }
        if (p === '/api/quests/duo_moment/claim') { assert(!s.claimed, 'No duplicate claim'); s.claimed = true; return json(route, { ...f.quest, status: 'rewarded' }); }
        if (p === '/api/moments/upload-url') {
          assert.equal(body.localDate, f.target.localDate); assert.equal(body.sessionId, f.target.sessionId); assert(body.sizeBytes > 0); s.uploads++;
          return json(route, { uploadUrl: `${h.baseURL}/__daily_mock__/upload/moment-${i}`, imageKey: `mock-moment-${i}`, expiresIn: 300, maxBytes: 5242880 });
        }
        if (p === '/api/moments/today') {
          assert.equal(body.localDate, f.target.localDate); assert.equal(body.sessionId, f.target.sessionId); assert.equal(body.key, `mock-moment-${i}`); s.posts++;
          if (s.mode === 'foreign') { faults.push({ label: i, path: p, status: 503 }); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MOCK_UNCERTAIN', message: 'Synthetic acknowledgement unavailable' } }) }); }
          s.saved = true; return json(route, { ...f.target, saved: true, postedAt: fixedTime });
        }
        if (p === '/api/water/upload-url') { assert.equal(i, 0); assert.equal(body.purpose, 'manual_proof'); assert.equal(body.mimeType, 'image/jpeg'); assert(body.sizeBytes > 0); water.uploads++; return json(route, { uploadUrl: `${h.baseURL}/__daily_mock__/upload/water`, imageKey: 'mock-manual-proof', expiresIn: 300, maxBytes: 5242880 }); }
        if (p === '/api/water/manual') {
          assert.equal(i, 0); assert.equal(body.amountMl, 350); assert.equal(body.imageKey, 'mock-manual-proof'); assert.equal(water.puts, 1); water.manuals++;
          water.log = { id: id(100), userId: f.users[0].id, amountMl: 350, source: 'manual', hasImage: true, status: 'pending', reviewedBy: null, localDate, createdAt: fixedTime };
          return json(route, { logId: water.log.id, amountMl: 350, status: 'pending', totalMl: 0, pendingMl: 350, goalMl: 2000 });
        }
        if (water.log && p === `/api/water/logs/${water.log.id}/approve`) { assert.equal(i, 1, 'Only partner context may approve'); water.approvals++; water.log.status = 'approved'; water.log.reviewedBy = f.users[1].id; return json(route, { logId: water.log.id, amountMl: 350, status: 'approved', totalMl: 350, goalMl: 2000, goalMet: false }); }
      }
      blocked.push({ label: i, method, path: p, reason: 'unexpected API' }); return route.abort('blockedbyclient');
    }
    // Vite documents/modules/assets only. This is the sole upstream continuation.
    if (method === 'GET' && !p.startsWith('/__daily_mock__/')) return route.continue();
    blocked.push({ label: i, method, path: p, reason: 'unexpected non-API request' }); return route.abort('blockedbyclient');
  }
  async function shot(page, name) {
    await page.evaluate(() => document.fonts.ready); await h.noOverflow(page);
    await h.screenshot(page, name, { fullPage: false });
    inventory.push({ screenshot: `${name}.png`, viewport: { width: 360, height: 780 }, manualReview: 'pending' });
  }
  async function capture(page) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: selectors.capture, exact: true }).click();
    await (await chooser).setFiles(imageFile);
    const dialog = page.getByRole('dialog', { name: selectors.composer, exact: true });
    await dialog.getByRole('img', { name: 'Ảnh bạn vừa chụp', exact: true }).waitFor();
    await dialog.getByPlaceholder('Bạn đang làm gì?').fill('Khoảnh khắc synthetic');
    return dialog;
  }
  try {
    browser = await h.openBrowser();
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: i ? 'reduce' : 'no-preference', deviceScaleFactor: 1, serviceWorkers: 'block' });
      await context.route('**/*', route => mock(route, i).catch(async error => { errors.push({ label: i, type: 'mock', message: h.sanitize(error.message) }); await route.abort('failed').catch(() => {}); }));
      // Vite HMR is unnecessary for a fixed-source verification; no websocket can escape the mock boundary.
      assert(context.routeWebSocket, 'Playwright must support fail-closed websocket routing');
      await context.routeWebSocket('**/*', socket => socket.onMessage(() => {}));
      await context.addInitScript(index => {
        localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: `mock-session-${index}`, tokens: { accessToken: `mock-access-${index}`, refreshToken: `mock-refresh-${index}` } }));
        localStorage.setItem('lw.space', 'couple');
      }, i);
      const page = await context.newPage(); clients.push({ context, page });
      page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(25000);
      await page.clock.setFixedTime(new Date(fixedTime));
      page.on('pageerror', error => errors.push({ label: i, type: 'pageerror', message: h.sanitize(error.message) }));
      page.on('console', message => { if (message.type() !== 'error') return; let resourcePath; try { resourcePath = new URL(message.location().url).pathname; } catch {} errors.push({ label: i, type: 'console', message: h.sanitize(message.text()), path: resourcePath }); });
      page.on('response', response => { if (response.status() >= 400) errors.push({ label: i, type: 'http', status: response.status(), path: new URL(response.url()).pathname }); });
      page.on('requestfailed', request => { if (!closing && request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push({ label: i, type: 'requestfailed', path: new URL(request.url()).pathname, message: h.sanitize(request.failure()?.errorText) }); });
    }
    const [a, b] = clients.map(c => c.page);
    stage = 'checkin-and-exp-only-claim';
    await a.goto(`${h.baseURL}/quests`);
    const checkinCard = a.locator('.checkin-card');
    await checkinCard.getByRole('button', { name: selectors.checkin, exact: true }).waitFor();
    assert.match(await checkinCard.innerText(), /5\s*Xu/, 'New daily check-in base copy');
    assert.match(await checkinCard.innerText(), /chuỗi/i, 'Streak policy copy');
    const questCard = a.locator('article.quest-card').filter({ has: a.getByRole('heading', { name: f.quest.title, exact: true }) });
    assert.match(await questCard.innerText(), /0\s*Xu từ nhiệm vụ.*Xu tự cộng riêng/, 'Explicit activity coins separate from quest EXP');
    assert(!/chia đều/.test(await questCard.innerText()), 'EXP-only quest must not advertise shared coin splitting');
    assert.match(await questCard.innerText(), /5\s*EXP/);
    await shot(a, '01-daily-policy');
    await checkinCard.getByRole('button', { name: selectors.checkin, exact: true }).click();
    await a.getByRole('button', { name: 'Đã điểm danh hôm nay', exact: true }).waitFor();
    await checkinCard.getByText('5 cơ bản + 2 thưởng chuỗi = 7 Xu của bạn', { exact: true }).waitFor();
    for (const close of await a.getByRole('button', { name: 'Đóng thông báo', exact: true }).all()) await close.click();
    await questCard.getByRole('button', { name: selectors.claim, exact: true }).click();
    await questCard.getByText('Đã nhận', { exact: true }).waitFor();
    const claimToast = a.getByRole('status').filter({ hasText: /5\s*EXP/ });
    await claimToast.first().waitFor();
    assert(!/0\s*Xu|chia đều/.test(await claimToast.first().innerText()), 'EXP-only success must not claim a coin reward');
    await shot(a, '02-checkin-exp-claimed'); checks.push(stage);

    stage = 'receipt-closes-before-refetch'; states[0].mode = 'receipt-held';
    await a.goto(`${h.baseURL}/moments`);
    const receiptSheet = await capture(a);
    await receiptSheet.getByRole('button', { name: selectors.post, exact: true }).click();
    await receiptSheet.waitFor({ state: 'hidden', timeout: 5000 });
    await until(() => states[0].heldReads > 0, 'invalidated moment GET is still held');
    assert.equal(states[0].posts, 1); assert.equal(states[0].uploads, 1);
    await a.getByText('Đã lưu Khoảnh khắc', { exact: true }).waitFor();
    await a.getByText('Ảnh đã lưu · đang cập nhật', { exact: true }).waitFor();
    await a.getByText('Ảnh đã lưu. Đang cập nhật ảnh và xác nhận thưởng; không cần đăng lại.', { exact: true }).waitFor();
    assert.equal(await a.getByRole('button', { name: selectors.capture, exact: true, includeHidden: true }).count(), 0, 'Confirmed receipt must prevent recapture while refetch hangs');
    assert.equal(await a.getByText(/Bạn chưa đăng|Bạn chưa chụp/).count(), 0, 'Confirmed receipt must not show stale unposted copy');
    assert.equal(await a.getByRole('img', { name: 'Ảnh của Bình', exact: true, includeHidden: true }).count(), 0, 'Receipt alone must not fabricate or unlock partner image');
    assert.equal(await a.getByRole('img', { name: 'Ảnh của Bạn', exact: true, includeHidden: true }).count(), 0, 'Receipt alone must not fabricate a signed own image');
    await a.locator('.mo-pair').first().evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot(a, '03-receipt-refetch-held'); checks.push(stage);
    states[0].mode = 'normal'; hold.release();

    stage = 'manual-water-proof';
    await a.goto(`${h.baseURL}/quests/water`);
    await a.getByRole('button', { name: selectors.manual, exact: true }).click();
    const manual = a.getByRole('dialog', { name: selectors.waterSheet, exact: true });
    await manual.getByRole('spinbutton').fill('350');
    const chooser = a.waitForEvent('filechooser');
    await manual.getByRole('button', { name: selectors.attachment, exact: true }).click();
    await (await chooser).setFiles(imageFile);
    const preview = manual.getByRole('img', { name: selectors.preview, exact: true });
    await preview.waitFor();
    await until(() => preview.evaluate(img => img.complete && img.naturalWidth > 0), 'decoded water preview');
    assert.match(await preview.getAttribute('src'), /^blob:/);
    await shot(a, '04-manual-proof-preview');
    await manual.locator('button[type="submit"]').click(); await manual.waitFor({ state: 'hidden' });
    await a.getByText('Chờ duyệt', { exact: true }).waitFor();
    assert.equal(water.manuals, 1); assert.equal(water.uploads, 1); assert.equal(water.puts, 1);
    assert(!requests.some(r => r.path === '/api/water/photo'), 'Manual proof never invokes AI photo analysis');
    await shot(a, '05-manual-pending'); checks.push(stage);

    stage = 'partner-proof-approval';
    await b.goto(`${h.baseURL}/notifications?filter=approvals`);
    const approval = b.locator('article.approval').filter({ has: b.getByRole('button', { name: selectors.approval, exact: true }) });
    const proof = approval.getByRole('img', { name: `Ảnh ly nước của ${f.users[0].displayName}`, exact: true });
    await proof.waitFor(); await until(() => proof.evaluate(img => img.complete && img.naturalWidth > 0), 'approval evidence URL image');
    assert.equal(await proof.getAttribute('src'), `${h.baseURL}/__daily_mock__/photo.png`);
    assert.match(await approval.innerText(), /Có ảnh minh chứng, không AI/); assert(water.evidenceReads > 0);
    await shot(b, '06-partner-evidence-loaded');
    await approval.getByRole('button', { name: selectors.approval, exact: true }).click(); await approval.waitFor({ state: 'hidden' });
    assert.equal(water.approvals, 1);
    await a.goto(`${h.baseURL}/quests/water`); await a.getByText('Đã xác nhận', { exact: true }).waitFor();
    await shot(a, '07-water-approved'); checks.push(stage);

    stage = 'uncertain-post-foreign-session-rejected'; states[1].mode = 'foreign';
    await b.goto(`${h.baseURL}/moments`);
    // Partner has posted but remains locked until THIS authenticated member posts in THIS session.
    assert.equal(await b.getByRole('img', { name: 'Ảnh của An', exact: true }).count(), 0);
    const uncertainSheet = await capture(b);
    const before = states[1].monthReads;
    await uncertainSheet.getByRole('button', { name: selectors.post, exact: true }).click();
    await uncertainSheet.getByRole('alert').filter({ hasText: 'Chưa xác nhận được ảnh đã lưu' }).waitFor();
    assert(states[1].monthReads > before, 'Uncertain POST reconciles through month GET');
    assert.equal(states[1].posts, 1); assert.equal(states[1].uploads, 1);
    assert(await uncertainSheet.getByRole('button', { name: selectors.reconcile, exact: true }).isEnabled());
    assert(await uncertainSheet.getByRole('button', { name: 'Chụp lại', exact: true }).isDisabled());
    assert.equal(await b.getByRole('img', { name: 'Ảnh của An', exact: true, includeHidden: true }).count(), 0, 'Foreign session must not unlock requested-session partner photo, including inert modal background');
    await uncertainSheet.getByRole('button', { name: selectors.reconcile, exact: true }).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot(b, '08-foreign-session-not-confirmed'); checks.push(stage);
    stage = 'uncertain-post-exact-session-reconciled';
    states[1].saved = true; states[1].mode = 'normal';
    await uncertainSheet.getByRole('button', { name: selectors.reconcile, exact: true }).click();
    await uncertainSheet.waitFor({ state: 'hidden' });
    await b.getByText('Đã lưu Khoảnh khắc', { exact: true }).waitFor();
    assert.equal(states[1].posts, 1, 'Recheck must not blindly repeat a possibly committed POST');
    assert.equal(states[1].uploads, 1, 'Recheck must reuse uploaded evidence');
    await b.getByRole('img', { name: 'Ảnh của An', exact: true }).waitFor();
    await b.locator('.mo-pair').first().evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot(b, '09-exact-session-reconciled'); checks.push(stage);

    stage = 'ledger-source-labels';
    await a.goto(`${h.baseURL}/profile`);
    await a.getByRole('heading', { name: /Lịch sử Xu \/ EXP/ }).getByRole('button', { name: 'Xem', exact: true }).click();
    // These labels intentionally fail if the new reason codes leak through as raw backend strings.
    for (const label of ['Điểm danh đủ đôi · Xu của bạn', 'Điểm danh cá nhân · EXP', 'Khoảnh khắc · ảnh đầu ngày', 'Khoảnh khắc · đủ đôi đúng giờ', 'Nhiệm vụ · EXP chung']) await a.getByText(label, { exact: true }).waitFor();
    assert(!await a.getByText(/^(checkin_pair|checkin_exp|photo_base|timely_pair_bonus|quest_exp)$/).count());
    await a.getByText('Khoảnh khắc · ảnh đầu ngày', { exact: true }).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot(a, '10-history-source-labels'); checks.push(stage);

    stage = 'error-budget-and-network-boundary';
    assert.deepEqual(blocked, [], 'All unexpected API/provider calls are blocked and fail the run');
    const budgets = new Map(faults.flatMap(fault => ['http', 'console'].map(type => [`${fault.label}|${type}|${fault.path}|${fault.status}`, 1])));
    const unexpected = [];
    for (const error of errors) {
      const resource = error.type === 'console' && /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(error.message);
      const status = error.type === 'http' ? error.status : resource ? Number(resource[1]) : 0;
      const key = `${error.label}|${error.type}|${error.path}|${status}`;
      if (budgets.get(key) > 0) budgets.set(key, budgets.get(key) - 1); else unexpected.push(error);
    }
    assert.deepEqual(unexpected, [], 'No unbudgeted browser errors');
    assert.deepEqual([...budgets].filter(([, count]) => count), [], 'Every injected fault observed exactly once');
    checks.push(stage);
    const observed = { moments: states.map(s => ({ posts: s.posts, uploads: s.uploads, monthReads: s.monthReads, heldReads: s.heldReads })), water: { uploads: water.uploads, puts: water.puts, manuals: water.manuals, approvals: water.approvals, evidenceReads: water.evidenceReads } };
    await h.writeResult({ ok: true, mockOnly: true, fixedTime, checks, inventory, observed, errors, faults, blocked, requests, selectors, limitations });
    console.log(`PASS ${checks.length} mock-only UI checks; evidence: ${h.evidenceDir}`);
  } catch (error) {
    const failure = h.sanitize(String(error?.message || error).split('\nCall log:')[0]);
    for (let i = 0; i < clients.length; i++) await h.screenshot(clients[i].page, `failure-${i}`, { fullPage: false }).catch(() => {});
    await h.writeResult({ ok: false, mockOnly: true, stage, fixedTime, checks, inventory, errors, faults, blocked, requests, selectors, failure, limitations });
    console.error(`${failure}\nEvidence: ${h.evidenceDir}`); process.exitCode = 1;
  } finally {
    closing = true; hold.release(); stream.release(); await browser?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
