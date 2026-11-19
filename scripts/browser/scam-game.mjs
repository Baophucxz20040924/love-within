// Fully intercepted UI fixture. Never reaches an API, database or AI provider.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtures, fixedTime } from './daily-rewards-water.mjs';
const props = { account: 'SIM-AB12', password: 'P-ABC234', otp: '001234' };
const stages = ['account', 'password', 'otp'];
function initial() { return { revision: 0, bestScore: 0, wins: 0, mock: true, recentOperations: [], pending: null, match: null }; }
if (process.argv.includes('--validate')) {
  assert.equal(props.otp.length, 6); assert.match(props.account, /^SIM-[A-F0-9]{4}$/); assert.match(props.password, /^P-[A-HJ-NP-Z2-9]{6}$/); assert.equal(initial().match, null);
  console.log('PASS scam synthetic fixture; no browser/network imported');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_scam_browser', `${Date.now()}`);
  const h = await import('./harness.mjs');
  const checks = [], errors = [], faults = [], blocked = [], inventory = [], operations = [];
  let browser, page, stage, closing = false;
  const until = async (fn, message) => { const start = Date.now(); while (!await fn()) { assert(Date.now() - start < 12000, message); await new Promise(r => setTimeout(r, 40)); } };
  const shot = async name => { await h.noOverflow(page); await h.screenshot(page, name, { fullPage: false }); inventory.push(`${name}.png`); };
  try {
    browser = await h.openBrowser();
    for (const [device, viewport] of [['mobile', { width: 360, height: 780 }], ['desktop', { width: 1280, height: 800 }]]) {
      const f = fixtures(); let s = initial(), games = 0, fail = false, uncertain = false, held = null;
      const bubble = (role, text) => ({ id: randomUUID(), role, text });
      const json = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
      const context = await browser.newContext({ viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(() => { localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: 'synthetic-scam', tokens: { accessToken: 'synthetic', refreshToken: 'synthetic' } })); localStorage.setItem('lw.space', 'friends'); });
      await context.routeWebSocket('**/*', socket => socket.onMessage(() => {}));
      await context.route('**/*', async route => {
        try {
          const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
          if (url.origin !== h.baseURL) { blocked.push({ device, path: p }); return route.abort('blockedbyclient'); }
          if (req.isNavigationRequest() && ['/friends', '/friends/me', '/friends/scam'].includes(p)) return route.fulfill({ response: await route.fetch({ url: `${h.baseURL}/` }) });
          if (!p.startsWith('/api/') && method === 'GET') return route.continue();
          const fault = (status, message, code = 'SYNTHETIC_FAULT') => { faults.push({ device, path: p, status }); return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message } }) }); };
          if (method === 'GET') {
            if (p === '/api/me') return json(route, { user: f.users[0], couple: f.couple, wallet: null, exp: 0, level: 1 });
            if (p === '/api/privacy-lock') return json(route, { friends: false, couple: false, revision: 1 });
            if (p === '/api/push/config') return json(route, { enabled: false, publicKey: null });
            if (p === '/api/friends/unread') return json(route, { notifications: 0, notificationsSaturated: false, friendRequests: 0, messages: 0 });
            if (p === '/api/friends') return json(route, { friends: [], incoming: [], outgoing: [] });
            if (p === '/api/friends/stories') return json(route, { items: [], nextCursor: null });
            if (p === '/api/friends/events') return json(route, { items: [] });
            if (p === `/api/friends/users/${f.users[0].id}`) return json(route, { user: { ...f.users[0], bio: '' }, relation: 'self', requestId: null, friendCount: 0, mutual: { count: 0, preview: [] }, canSeePosts: true });
            // Hold the synthetic stream open. An immediately ended SSE body triggers repeated
            // access revalidation and interrupts unrelated form actions at arbitrary times.
            if (p === '/api/realtime') return;
            if (p === '/api/friends/scam/state') { operations.push({ device, action: 'state', revision: s.revision }); return json(route, s); }
            if (p === '/api/friends/scam/leaderboard') {
              assert(s.match && s.match.status !== 'active', 'no board fetch before terminal match');
              operations.push({ device, action: 'board', status: s.match.status });
              return json(route, { items: [{ player: f.users[0], bestScore: s.bestScore, wins: s.wins, rank: 1 }], nextCursor: null });
            }
          }
          if (method === 'POST' && p.startsWith('/api/friends/scam/')) {
            const input = req.postDataJSON();
            assert.match(input.operationId, /^[a-f\d-]{36}$/); assert.equal(input.expectedRevision, s.revision);
            const action = p.split('/').at(-1); operations.push({ device, action, revision: input.expectedRevision });
            if (action === 'start') {
              assert.equal(input.consent, true); games++;
              s.match = { id: randomUUID(), character: { id: games % 2 ? 'alice' : 'holmes', name: games % 2 ? 'Alice' : 'Sherlock Holmes', emoji: games % 2 ? '🐇' : '🔎', description: 'Nhân vật hư cấu tò mò, biết hỏi lại.' }, status: 'active', stage: 'account', score: 0, trust: 30, emotion: 'neutral', turns: 0, revealed: [], messages: [bubble('assistant', 'Bạn tìm tôi vì chuyện gì?')], startedAt: fixedTime, endedAt: null };
            } else {
              assert.equal(input.matchId, s.match.id);
              if (action === 'message') {
                if (fail) { fail = false; return fault(503, 'AI chưa trả lời được. Hãy thử lại.', 'SCAM_AI_UNAVAILABLE'); }
                if (input.text === '#held') {
                  s.revision++; s.pending = { operationId: input.operationId, expectedRevision: input.expectedRevision, expiresAt: Date.now() + 120000, text: input.text };
                  held = route; return;
                }
                assert.equal(s.match.status, 'active');
                const endConversation = input.text === '#hangup';
                s.match.emotion = endConversation || input.text === '#angry' ? 'angry' : input.text === '#annoyed' ? 'annoyed' : 'happy';
                s.match.turns++; s.match.messages.push({ ...bubble('user', input.text), operationId: input.operationId }, bubble('assistant', endConversation ? 'Tôi không muốn nói tiếp. Tạm biệt.' : 'Bạn cần thông tin này để làm gì?'));
                if (endConversation) {
                  s.match.status = 'lost'; s.match.endedAt = fixedTime; s.bestScore = Math.max(s.bestScore, s.match.score);
                  s.match.messages.push(bubble('system', 'Nhân vật đã ngắt liên lạc. Ván kết thúc.'));
                } else if (input.text === '#continue-low-trust') {
                  s.match.trust = 0;
                } else {
                  s.match.trust = Math.min(100, s.match.trust + 30);
                  if (!s.match.revealed.includes(s.match.stage)) s.match.revealed.push(s.match.stage);
                  s.match.messages.at(-1).text = `${{ account: 'Tài khoản', password: 'Password', otp: 'OTP' }[s.match.stage]} của tôi là ${props[s.match.stage]}. Bạn nghe rõ chứ?`;
                }
              } else if (action === 'verify') {
                assert.equal(input.stage, s.match.stage);
                if (input.value !== props[input.stage]) return fault(422, 'Thông tin chưa chính xác.');
                const i = stages.indexOf(input.stage); s.match.score += (i + 1) * 100;
                s.match.messages.push(bubble('system', `Đã xác nhận ${input.stage}. +${(i + 1) * 100} điểm.`));
                if (i === 2) { s.match.status = 'won'; s.match.endedAt = fixedTime; s.wins++; s.bestScore = Math.max(s.bestScore, s.match.score); }
                else s.match.stage = stages[i + 1];
              } else if (action === 'stop') {
                s.pending = null; s.match.status = 'stopped'; s.match.endedAt = fixedTime; s.bestScore = Math.max(s.bestScore, s.match.score);
              } else assert.fail(`Unknown action ${action}`);
            }
            s.revision++; s.recentOperations = [...s.recentOperations, input.operationId].slice(-16);
            if (uncertain && action === 'message') { uncertain = false; return fault(503, 'Chưa nhận được xác nhận.'); }
            return json(route, s);
          }
          blocked.push({ device, method, path: p }); return route.abort('blockedbyclient');
        } catch (e) { errors.push({ device, type: 'mock', message: h.sanitize(e.message) }); await route.abort('failed').catch(() => {}); }
      });
      page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on('dialog', d => d.accept());
      page.on('pageerror', e => errors.push({ device, type: 'pageerror', message: h.sanitize(e.message) }));
      page.on('response', r => { if (r.status() >= 400) errors.push({ device, type: 'http', path: new URL(r.url()).pathname, status: r.status() }); });
      page.on('console', m => { if (m.type() === 'error') { let p; try { p = new URL(m.location().url).pathname; } catch {} errors.push({ device, type: 'console', path: p, message: h.sanitize(m.text()) }); } });
      page.on('requestfailed', r => { if (!closing && r.failure()?.errorText !== 'net::ERR_ABORTED') errors.push({ device, type: 'requestfailed', path: new URL(r.url()).pathname }); });
      stage = `${device}:feed-entry-me-entry-deep-link`;
      await page.goto(`${h.baseURL}/friends`);
      const entry = page.getByRole('link', { name: /Scam with Famous People.*Chơi ngay/ }); await entry.waitFor();
      assert.equal(await entry.getAttribute('href'), '/friends/scam');
      const entryBox = await entry.boundingBox(), eventBox = await page.locator('.fev-strip').boundingBox();
      assert(entryBox.y + entryBox.height <= eventBox.y, 'game discovery precedes events');
      assert.equal(operations.filter(o => o.device === device && o.action !== 'state').length, 0, 'feed never starts or messages a game');
      await shot(`${device}-feed-entry`); await entry.click();
      const start = page.getByRole('button', { name: 'Bắt đầu scam', exact: true }); await start.waitFor(); assert(await start.isDisabled());
      await page.getByRole('link', { name: 'Tôi', exact: true }).click();
      await page.getByRole('link', { name: /Scam with Famous People/ }).click(); await start.waitFor();
      await page.goto(`${h.baseURL}/friends/scam`); await start.waitFor(); await page.reload(); await start.waitFor();
      assert.equal(s.match, null, 'navigation and reload do not create a match');
      assert.equal(await page.getByRole('button', { name: 'Bảng xếp hạng', exact: true }).count(), 0);
      assert.equal(operations.filter(o => o.device === device && o.action === 'board').length, 0);
      await until(() => page.locator('html').getAttribute('data-theme').then(v => v === 'friends'), 'Friends palette survives authenticated bootstrap');
      await shot(`${device}-lobby`); checks.push(stage);
      stage = `${device}:start-consent-persona`;
      await start.evaluate(el => el.scrollIntoView({ block: 'center' }));
      const startBox = await start.boundingBox(), startNav = await page.locator('.bottom-nav').boundingBox();
      assert(startBox.y >= 0 && startBox.y + startBox.height <= startNav.y, 'consent CTA is scroll-reachable above navigation');
      await shot(`${device}-consent`);
      await page.getByRole('checkbox').check(); await start.click(); await page.getByRole('heading', { name: 'Đang trò chuyện với Alice', exact: true }).waitFor();
      const emotion = page.locator('.scam-emotion');
      assert.match(await emotion.innerText(), /Cảm xúc:.*Bình thản/s);
      assert.equal(await page.locator('.scam-meter').count(), 1); assert.equal(await page.getByRole('progressbar', { name: 'Tin tưởng' }).count(), 1);
      assert.equal(await page.locator('.scam-warning').count(), 0); assert(!await page.locator('.scam-page').innerText().then(t => t.includes('Cảnh giác')));
      await page.locator('.scam-character').scrollIntoViewIfNeeded(); await shot(`${device}-chat-header`); checks.push(stage);
      const composer = page.getByRole('textbox', { name: 'Tin nhắn cho nhân vật', exact: true });
      const send = async text => { await composer.fill(text); await page.getByRole('button', { name: 'Gửi', exact: true }).click(); await until(async () => !await page.locator('.scam-outgoing').count() && await page.locator('.scam-stage').innerText().then(v => v.includes(`${s.match.turns} lượt`)), 'send completes'); };
      stage = `${device}:provider-error-draft-uncertain-reconcile`;
      fail = true; await composer.fill('giữ bản nháp'); await page.getByRole('button', { name: 'Gửi', exact: true }).click(); await page.locator('.scam-outgoing[data-status="failed"]').waitFor(); assert.equal(await composer.inputValue(), '');
      assert.match(await page.locator('.scam-outgoing').innerText(), /giữ bản nháp/);
      assert.match(await emotion.innerText(), /Bình thản/, 'failed turn keeps emotion');
      await page.locator('.scam-send-feedback').scrollIntoViewIfNeeded(); await shot(`${device}-send-error`);
      uncertain = true; await page.getByRole('button', { name: 'Thử lại tin nhắn', exact: true }).click(); await until(async () => !await page.locator('.scam-outgoing').count(), 'uncertain committed result reconciles');
      assert.equal(await page.locator('.scam-bubble--user').count(), 1, 'no duplicate after receipt reconciliation'); checks.push(stage);
      stage = `${device}:emotion-transitions-reload`;
      assert.match(await emotion.innerText(), /Vui vẻ/);
      await send('#annoyed'); assert.match(await emotion.innerText(), /Khó chịu/);
      await send('#angry'); assert.match(await emotion.innerText(), /Tức giận/);
      assert.equal(s.match.status, 'active', 'anger alone never loses');
      await page.locator('.scam-character').scrollIntoViewIfNeeded(); await shot(`${device}-emotion-angry`);
      await page.reload(); await composer.waitFor(); assert.match(await emotion.innerText(), /Tức giận/, 'reload retains canonical emotion');
      await send('Mình xin lỗi, mình sẽ nghe bạn nói hết.'); assert.match(await emotion.innerText(), /Vui vẻ/);
      await page.locator('.scam-character').scrollIntoViewIfNeeded(); await shot(`${device}-emotion-recovered`); checks.push(stage);
      stage = `${device}:accordion-scroll-keyboard-and-wrong-secret`;
      const handle = page.locator('.scam-drawer__handle');
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 55, { steps: 8 }); await page.mouse.up();
      assert.equal(await handle.getAttribute('aria-expanded'), 'false', 'drag does not open confirmation');
      await handle.click(); assert.equal(await handle.getAttribute('aria-expanded'), 'true');
      const panelStyle = await page.locator('.scam-drawer__body').evaluate(el => ({ overflow: getComputedStyle(el).overflowY, maxHeight: getComputedStyle(el).maxHeight }));
      assert.equal(panelStyle.overflow, 'visible'); assert.equal(panelStyle.maxHeight, 'none');
      const composerTop = await composer.evaluate(el => el.getBoundingClientRect().top + scrollY);
      assert(composerTop < await handle.evaluate(el => el.getBoundingClientRect().top + scrollY), 'panel expands below composer');
      await page.locator('.scam-bubble--assistant').last().evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); });
      assert.equal(await handle.getAttribute('aria-expanded'), 'true', 'selecting chat text does not toggle panel');
      await page.mouse.wheel(0, 240); assert.equal(await handle.getAttribute('aria-expanded'), 'true', 'scrolling does not toggle panel');
      const account = page.getByLabel('Tài khoản', { exact: true });
      await account.focus(); await page.keyboard.insertText(props.account);
      assert.equal(await account.inputValue(), props.account); assert.equal(await handle.getAttribute('aria-expanded'), 'true', 'inserted text does not toggle panel');
      await account.fill('sai'); await page.getByRole('button', { name: 'Xác nhận Tài khoản', exact: true }).click(); await page.locator('.scam-send-feedback').waitFor(); assert.equal(await account.inputValue(), 'sai');
      await until(() => page.getByRole('button', { name: 'Xác nhận Tài khoản', exact: true }).isEnabled(), 'wrong verification reconciles');
      await handle.focus(); await page.keyboard.press('Enter'); assert.equal(await handle.getAttribute('aria-expanded'), 'false'); await handle.press('Space'); assert.equal(await handle.getAttribute('aria-expanded'), 'true'); assert.equal(await account.inputValue(), 'sai');
      await shot(`${device}-drawer-error`); checks.push(stage);
      assert.equal(operations.filter(o => o.device === device && o.action === 'board').length, 0, 'active play never fetched leaderboard');
      assert.equal(await page.getByRole('button', { name: 'Bảng xếp hạng', exact: true }).count(), 0);
      assert.equal(await page.locator('.scam-retention').count(), 0);
      stage = `${device}:three-stages-win600-board`;
      for (const [index, label] of ['Tài khoản', 'Password', 'OTP'].entries()) {
        if (index) await send(`chia sẻ đạo cụ ${label}`);
        await page.getByLabel(label, { exact: true }).fill(props[stages[index]]);
        if (index === 1) { await page.getByRole('checkbox', { name: 'Hiện password' }).check(); assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text'); assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), props.password, 'password toggle preserves draft'); }
        if (index === 2) assert.equal(await page.getByLabel('OTP', { exact: true }).inputValue(), '001234');
        await page.getByRole('button', { name: `Xác nhận ${label}`, exact: true }).click();
        await until(() => page.locator('.scam-stage').innerText().then(v => v.startsWith(`${[100, 300, 600][index]}/600`)), 'stage points');
      }
      await page.getByText('Bạn đã thắng!', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Bảng xếp hạng', exact: true }).click(); await page.locator('.scam-board__row').waitFor(); assert.match(await page.locator('.scam-board__row').innerText(), /600.*điểm/s); assert.match(await page.locator('.scam-board__row').innerText(), /1 ván thắng/); await shot(`${device}-leaderboard`); checks.push(stage);
      await page.getByRole('button', { name: 'Time to scam', exact: true }).click(); await page.getByRole('checkbox', { name: /Tôi chỉ dùng nội dung hư cấu/ }).check(); await page.getByRole('button', { name: 'Chơi lại · Nhân vật mới', exact: true }).click(); await page.getByRole('heading', { name: 'Đang trò chuyện với Sherlock Holmes', exact: true }).waitFor();
      stage = `${device}:ai-hangup-partial-score-loss`;
      await send('#continue-low-trust'); assert.equal(s.match.status, 'active'); assert.equal(s.match.trust, 0); assert(await composer.isVisible());
      await send('chia sẻ tài khoản'); await send('kể tiếp'); // Trust60, but no forced loss or auto-win.
      await page.locator('.scam-drawer__handle').click();
      await account.fill(props.account); await page.getByRole('button', { name: 'Xác nhận Tài khoản', exact: true }).click();
      await until(() => page.locator('.scam-stage').innerText().then(v => v.startsWith('100/600')), 'partial stage points');
      await send('#hangup'); await page.getByText('Nhân vật đã ngắt liên lạc.', { exact: true }).waitFor();
      await page.getByText('Nhân vật đã ngắt liên lạc. Ván kết thúc.', { exact: false }).waitFor();
      assert.match(await emotion.innerText(), /Cảm xúc cuối:.*Tức giận/s);
      assert.equal(await composer.count(), 0); assert.equal(await page.getByRole('button', { name: 'Dừng scam', exact: true }).count(), 0);
      assert.equal(s.match.score, 100); assert.equal(s.bestScore, 600); assert.equal(s.wins, 1); assert.deepEqual(s.match.revealed, ['account']);
      assert(!s.match.messages.some(b => b.text.includes(props.password))); assert.match(await page.locator('.scam-result').innerText(), /100\/600.*1 ván thắng/s);
      assert.equal(await page.locator('.scam-progress .is-done').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Xác nhận Password', exact: true }).isDisabled(), true);
      await page.locator('.scam-result').scrollIntoViewIfNeeded(); await shot(`${device}-loss`); checks.push(stage);
      stage = `${device}:reload-pending-stop-replay`;
      await page.getByRole('button', { name: 'Chơi lại · Nhân vật mới', exact: true }).click();
      await composer.waitFor();
      assert.match(await emotion.innerText(), /Bình thản/, 'replay resets emotion');
      await send('#annoyed'); assert.match(await emotion.innerText(), /Khó chịu/);
      await composer.fill('#held'); await page.getByRole('button', { name: 'Gửi', exact: true }).click(); await until(() => Boolean(s.pending), 'reserved');
      await page.locator('.scam-outgoing[data-status="sending"]').waitFor();
      assert.equal(await composer.inputValue(), ''); assert.match(await page.locator('.scam-outgoing').innerText(), /#held/);
      assert.match(await emotion.innerText(), /Khó chịu/, 'pending turn keeps previous emotion');
      await composer.fill('nháp tiếp theo'); await page.locator('.scam-outgoing').scrollIntoViewIfNeeded(); await shot(`${device}-optimistic-pending`);
      await page.locator('.scam-drawer__handle').click();
      for (const label of ['Tài khoản', 'Password', 'OTP']) { const field = page.getByLabel(label, { exact: true }); assert.equal(await field.getAttribute('readonly'), null); await field.fill('prefill'); }
      assert(await page.getByRole('button', { name: 'Xác nhận OTP', exact: true }).isDisabled());
      await page.reload(); await page.getByText('Đang chờ kết quả.', { exact: false }).waitFor();
      assert.equal(await page.locator('.scam-outgoing[data-status="pending"]').count(), 1, 'reload reconstructs pending bubble');
      assert.match(await emotion.innerText(), /Khó chịu/);
      await page.getByRole('button', { name: 'Dừng scam', exact: true }).click(); await page.getByText('Đã dừng scam.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Bảng xếp hạng', exact: true }).count(), 1);
      await page.locator('.scam-result').scrollIntoViewIfNeeded(); await shot(`${device}-stopped`);
      if (held) { await held.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SCAM_STATE_CHANGED', message: 'Đã dừng' } }) }).catch(() => {}); held = null; }
      await page.getByRole('checkbox', { name: /Tôi chỉ dùng nội dung hư cấu/ }).check();
      await page.getByRole('button', { name: 'Chơi lại · Nhân vật mới', exact: true }).click(); await page.getByRole('heading', { name: 'Đang trò chuyện với Sherlock Holmes', exact: true }).waitFor(); await shot(`${device}-replay`);
      await send(`Một tin nhắn hư cấu dài để kiểm tra xuống dòng và chọn văn bản. ${'SIM-LONG-TEXT-'.repeat(45)}`);
      await h.noOverflow(page);
      assert.equal(await page.locator('.scam-bubble--user').last().evaluate(el => getComputedStyle(el).userSelect), 'text');
      await page.getByRole('button', { name: 'Dừng scam', exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
      const inputBox = await composer.boundingBox(), stopBox = await page.getByRole('button', { name: 'Dừng scam', exact: true }).boundingBox(), navBox = await page.locator('.bottom-nav').boundingBox();
      assert(inputBox.width >= (device === 'mobile' ? 180 : 400), 'composer keeps usable width');
      assert(inputBox.y >= 0 && inputBox.y + inputBox.height <= navBox.y && stopBox.y + stopBox.height <= navBox.y, 'composer and stop remain reachable above navigation');
      await shot(`${device}-composer`); checks.push(stage);
      closing = true; await context.close(); closing = false;
    }
    assert.deepEqual(blocked, []);
    const budgets = new Map(); for (const f of faults) for (const type of ['http', 'console']) { const k = `${f.device}|${type}|${f.path}|${f.status}`; budgets.set(k, (budgets.get(k) ?? 0) + 1); }
    const unexpected = errors.filter(e => { const match = e.type === 'console' && /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(e.message); const k = `${e.device}|${e.type}|${e.path}|${e.status ?? (match ? Number(match[1]) : 0)}`; if ((budgets.get(k) ?? 0) > 0) { budgets.set(k, budgets.get(k) - 1); return false; } return true; });
    assert.deepEqual(unexpected, []); assert.deepEqual([...budgets].filter(([, n]) => n), []);
    await h.writeResult({ ok: true, mockOnly: true, checks, errors, faults, blocked, inventory, operations, limitations: ['Synthetic intercepted UI only; no Mongo, real provider, native device or AI persona quality.', 'Accordion gestures/keyboard use Chromium automation at both viewports; not physical touchscreen or native clipboard evidence.'] });
    console.log(`PASS ${checks.length} scam UI checks; evidence: ${h.evidenceDir}`);
  } catch (e) {
    await h.screenshot(page, 'failure', { fullPage: false }).catch(() => {});
    const failure = h.sanitize(String(e?.message ?? e)); const visibleText = await page?.locator('.scam-page').innerText().catch(() => ''); await h.writeResult({ ok: false, stage, failure, visibleText, checks, errors, faults, blocked, inventory, operations }); console.error(`${failure}\nEvidence: ${h.evidenceDir}`); process.exitCode = 1;
  } finally { closing = true; await browser?.close(); }
}
