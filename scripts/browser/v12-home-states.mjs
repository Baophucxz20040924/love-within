// Browser-injected GET fixtures exercise rendering, not backend population or login UX.
// Requires the existing private paired LW_BASELINE_FIXTURE and running local services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { classify, fixedTime, fixtures as dailyFixtures } from './v12-daily-states.mjs';

const id = n => n.toString(16).padStart(24, '0');
export function fixtures(owner, partner) {
  const now = new Date(fixedTime), date = now.toISOString().slice(0, 10), at = now.toISOString();
  const question = { id: id(901), localDate: date, text: 'Kỷ niệm nào của hai bạn khiến bạn mỉm cười ngay cả trong những ngày thật bận rộn?', category: 'Kỷ niệm', source: 'bank', askedBy: null, mine: null, partner: { answered: true }, locked: false, myAsk: null };
  const mood = (userId, value) => ({ userId, localDate: date, mood: value, note: '', updatedAt: at });
  const dense = {
    question: { id: question.id, state: 'partner_answered' },
    letters: { openable: 3, openableId: id(902), nextOpenOn: null },
    nextEvent: { id: id(903), auto: false, title: 'Chuyến đi thật dài để cùng nhau khám phá những nơi mới và lưu giữ kỷ niệm', emoji: '🌸', kind: 'trip', date, time: null, startsAt: null, daysLeft: 0, others: 3 },
    nudges: { receivedToday: 5, lastAt: at, lastKind: 'hug' },
    moods: { mine: mood(owner.id, 'happy'), partner: mood(partner.id, 'loved') },
    moment: { state: 'open', windowEndsAt: new Date(now.getTime() + 600000).toISOString(), partnerPosted: true },
    savings: { id: id(904), title: 'Một mục tiêu tiết kiệm thật dài cho chuyến đi và những dự định của chúng mình', emoji: '🌱', totalVnd: 9999999999, targetVnd: 10000000000, status: 'active', reachedAt: null },
  };
  const empty = Object.fromEntries(Object.keys(dense).map(key => [key, null]));
  return { dense, empty, question };
}
export function validate() {
  const { dense, empty, question } = fixtures({ id: id(1) }, { id: id(2) });
  assert.deepEqual(Object.keys(dense), ['question', 'letters', 'nextEvent', 'nudges', 'moods', 'moment', 'savings']);
  assert(Object.values(empty).every(value => value === null));
  assert.equal(dense.question.id, question.id);
  assert.equal(dense.question.state, 'partner_answered');
  assert.equal(question.partner.answered, true);
  assert.equal(dense.savings.totalVnd, 9999999999);
}
async function main() {
  validate();
  if (process.argv.includes('--validate')) { console.log('Fixture validation passed'); return; }
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-home-states-${Date.now()}`);
  const h = await import('./harness.mjs');
  let browser;
  const checks = [], inventory = [], errors = []; let stage = 'startup';
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const baseline = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(baseline.synthetic === true && baseline.users?.length === 2, 'Synthetic paired baseline required');
    const [owner, partner] = baseline.users;
    assert(owner.id && partner.id && owner.id !== partner.id, 'Two distinct paired users required');
    // Ordinary API login, tokens retained in memory only; this is not login-flow proof.
    const login = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
    const me = await h.api('GET', '/me', undefined, login.accessToken);
    assert.equal(me.user.id, owner.id); assert(me.user.coupleId && me.couple, 'Paired baseline required');
    assert(me.couple.members.some(m => m.id === partner.id), 'Baseline partner mismatch');
    const data = fixtures(owner, partner), daily = dailyFixtures(owner, partner);
    browser = await h.openBrowser();
    const viewports = [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }];
    // Three explicit pulse states at every viewport, including the formerly missing 390 failure.
    const cases = ['dense', 'empty', 'pulse-error'].flatMap(state => viewports.map(viewport => ({ state, viewport })));
    for (const { state, viewport } of cases) {
      const observed = [], blocked = []; let pulseFailures = 0, pulseRecovered = false, recoveryRequests = 0;
      const { context, page } = await h.fresh(browser, `${state}-${viewport.width}`, observed);
      await page.setViewportSize(viewport);
      await page.clock.setFixedTime(new Date(fixedTime));
      await context.addInitScript(tokens => {
        localStorage.setItem('lw.accessToken', tokens.accessToken);
        localStorage.setItem('lw.refreshToken', tokens.refreshToken);
        localStorage.setItem('lw.space', 'couple');
      }, login);
      // All mutations are blocked. Common Home dependencies are deterministic GET DTOs.
      await context.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { blocked.push(request.method()); return route.abort(); }
        const send = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: value }) });
        if (url.pathname === '/api/proposals' && url.searchParams.get('status') === 'pending') return send([]);
        if (url.search) return route.continue();
        if (url.pathname === '/api/me') return send(me);
        if (url.pathname === '/api/couple') return send(me.couple);
        if (url.pathname === '/api/checkin') return send(daily.checkin);
        if (url.pathname === '/api/quests/today') return send(daily.quests);
        if (['/api/water/pending', '/api/market/redemptions/pending'].includes(url.pathname)) return send([]);
        if (url.pathname === '/api/market/unread-count') return send({ count: 0, responded: 0, newItems: 0 });
        if (url.pathname === '/api/wallet') return send({ coinBalance: 1000000, level: 12, exp: 1250, levelBaseExp: 1200, nextLevelExp: 1400 });
        if (url.pathname === '/api/finance/connection') return send({ linked: false, status: null });
        if (url.pathname === '/api/couple/pulse') {
          if (state === 'pulse-error' && !pulseRecovered) { pulseFailures++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }) }); }
          if (pulseRecovered) recoveryRequests++;
          return send(data[state === 'pulse-error' ? 'dense' : state]);
        }
        if (url.pathname === '/api/questions/today') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: data.question }) });
        return route.continue();
      });
      await page.goto(`${h.baseURL}/`);
      stage = `${state}-${viewport.width}: sections`;
      await page.getByRole('heading', { name: 'Dành cho hai bạn' }).waitFor();
      await page.getByRole('heading', { name: 'Nhịp sống chung' }).waitFor();
      stage = `${state}-${viewport.width}: question`;
      await page.getByRole('heading', { name: 'Câu hỏi hôm nay' }).waitFor();
      stage = `${state}-${viewport.width}: pulse cards`;
      if (state === 'dense') {
        await page.getByRole('heading', { name: 'Khoảnh khắc đang mở' }).waitFor();
        await page.getByText('Chạm để mở phong bì').waitFor();
        await page.getByText('Sắp tới', { exact: true }).waitFor();
        await page.getByRole('link', { name: `Quỹ chung: ${data.dense.savings.title}`, exact: true }).waitFor();
        await page.locator('.hero-row--mine').waitFor();
      } else if (state === 'empty') {
        assert.equal(await page.locator('.mo-card, .letter-card, .ev-card').count(), 0);
        assert.equal(await page.getByText(data.dense.savings.title, { exact: true }).count(), 0);
      } else {
        await page.getByText('Chưa cập nhật được hoạt động', { exact: true }).waitFor();
        await page.getByText('Một số hoạt động chưa hiển thị. Thử tải lại nhé.', { exact: true }).waitFor();
        assert.equal(await page.locator('.mo-card, .letter-card, .ev-card').count(), 0);
      }
      await page.evaluate(() => document.fonts.ready);
      for (const [position, fraction] of [['top', 0], ['mid', 0.5], ['bottom', 1]]) {
        await page.evaluate(f => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), fraction);
        await h.noOverflow(page);
        const name = `home-${state}-${viewport.width}-${position}`;
        await h.screenshot(page, name, { fullPage: false });
        inventory.push({ state, width: viewport.width, position, screenshot: `${name}.png` });
      }
      const bottom = page.locator('.wallet-card');
      await bottom.scrollIntoViewIfNeeded();
      assert(await bottom.evaluate(el => { const r = el.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }), 'Home wallet bottom reachable');
      if (state === 'pulse-error') {
        assert.equal(pulseFailures, 2, 'Initial pulse failure and one automatic retry only');
        const alert = page.getByRole('alert').filter({ hasText: 'Chưa cập nhật được hoạt động' });
        pulseRecovered = true; await alert.getByRole('button', { name: 'Thử lại', exact: true }).click();
        await alert.waitFor({ state: 'hidden' }); await page.getByRole('heading', { name: 'Khoảnh khắc đang mở' }).waitFor();
        assert.equal(recoveryRequests, 1, 'One manual pulse recovery request');
        await page.evaluate(() => scrollTo(0, 0)); await h.noOverflow(page);
        const name = `home-${state}-${viewport.width}-retry`; await h.screenshot(page, name, { fullPage: false });
        inventory.push({ state: 'pulse-retry', width: viewport.width, position: 'top', screenshot: `${name}.png` });
      }
      assert.equal(blocked.length, 0, 'Unexpected mutation blocked');
      classify(observed, state === 'pulse-error' ? [{ label: `${state}-${viewport.width}`, path: '/api/couple/pulse', status: 503, count: 2 }] : []);
      errors.push(...observed);
      checks.push(`${state} ${viewport.width}: headings and state checked; three viewport captures`);
      await context.close();
    }
    await h.writeResult({ ok: true, checks, inventory, errors, limitations: ['Synthetic browser GET fixtures; no backend population, login-flow or mutation proof', 'Pulse failure/retry is injected and exactly counted; fixed browser date and common GET fixtures', 'Screenshots require manual visual review; selected cases only'] });
    console.log(`PASS ${checks.length} cases; ${inventory.length} captures; ${h.evidenceDir}`);
  } catch (error) {
    const failure = h.sanitize(String(error.message).split('\nCall log:')[0]);
    await h.writeResult({ ok: false, checks, inventory, stage, failure });
    console.error(failure);
    console.error('Home state verification failed; inspect locally without publishing sensitive values.');
    process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
