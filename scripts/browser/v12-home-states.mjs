// Browser-injected GET fixtures exercise rendering, not backend population or login UX.
// Requires the existing private paired LW_BASELINE_FIXTURE and running local services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const id = n => n.toString(16).padStart(24, '0');
export function fixtures(owner, partner) {
  const now = new Date(), date = now.toISOString().slice(0, 10), at = now.toISOString();
  const question = { id: id(901), localDate: date, text: 'Kỷ niệm nào của hai bạn khiến bạn mỉm cười ngay cả trong những ngày thật bận rộn?', category: 'Kỷ niệm', source: 'bank', askedBy: null, mine: null, partner: { answered: true }, locked: false, myAsk: null };
  const mood = (userId, value) => ({ userId, localDate: date, mood: value, note: '', updatedAt: at });
  const dense = {
    question: { id: question.id, state: 'partner_answered' },
    letters: { openable: 3, openableId: id(902), nextOpenOn: null },
    nextEvent: { id: id(903), auto: false, title: 'Chuyến đi thật dài để cùng nhau khám phá những nơi mới và lưu giữ kỷ niệm', emoji: '🌸', kind: 'trip', date, time: null, startsAt: null, daysLeft: 0, others: 3 },
    nudges: { receivedToday: 5, lastAt: at, lastKind: 'hug' },
    moods: { mine: mood(owner.id, 'happy'), partner: mood(partner.id, 'loved') },
    moment: { state: 'open', windowEndsAt: new Date(now.getTime() + 600000).toISOString(), partnerPosted: true },
    savings: { id: id(904), title: 'Một mục tiêu tiết kiệm thật dài cho chuyến đi và những dự định của chúng mình', emoji: '🌱', totalVnd: 9999999999, targetVnd: 20000000000, status: 'active', reachedAt: null },
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
  const checks = [], inventory = [], errors = [];
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const baseline = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(baseline.synthetic && baseline.users?.length === 2, 'Synthetic paired baseline required');
    const [owner, partner] = baseline.users;
    assert(owner.id && partner.id && owner.id !== partner.id, 'Two distinct paired users required');
    // Ordinary API login, tokens retained in memory only; this is not login-flow proof.
    const login = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
    const data = fixtures(owner, partner);
    browser = await h.openBrowser();
    const viewports = [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }];
    // Eight selected cases, rather than a complete state/viewport matrix.
    const cases = [...viewports.map(viewport => ({ state: 'dense', viewport })), ...viewports.map(viewport => ({ state: 'empty', viewport })), ...[viewports[0], viewports[2]].map(viewport => ({ state: 'pulse-error', viewport }))];
    for (const { state, viewport } of cases) {
      const observed = [], blocked = [];
      const { context, page } = await h.fresh(browser, `${state}-${viewport.width}`, observed);
      await page.setViewportSize(viewport);
      await context.addInitScript(tokens => {
        localStorage.setItem('lw.accessToken', tokens.accessToken);
        localStorage.setItem('lw.refreshToken', tokens.refreshToken);
        localStorage.setItem('lw.space', 'couple');
      }, login);
      // All mutations are blocked, not emulated. Only two exact GET endpoints are replaced.
      await context.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { blocked.push(request.method()); return route.abort(); }
        if (url.search) return route.continue();
        if (url.pathname === '/api/couple/pulse') {
          if (state === 'pulse-error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: data[state] }) });
        }
        if (url.pathname === '/api/questions/today') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: data.question }) });
        return route.continue();
      });
      await page.goto(`${h.baseURL}/`);
      await page.getByRole('heading', { name: 'Dành cho hai bạn' }).waitFor();
      await page.getByRole('heading', { name: 'Nhịp sống chung' }).waitFor();
      await page.getByRole('heading', { name: 'Câu hỏi hôm nay' }).waitFor();
      if (state === 'dense') {
        await page.getByRole('heading', { name: 'Khoảnh khắc đang mở' }).waitFor();
        await page.getByText('Chạm để mở phong bì').waitFor();
        await page.getByText('Sắp tới', { exact: true }).waitFor();
        await page.getByText(data.dense.savings.title, { exact: true }).waitFor();
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
      assert.equal(blocked.length, 0, 'Unexpected mutation blocked');
      // Do not serialize raw URLs, errors, account identifiers, or credentials to evidence.
      const unexpected = observed.filter(e => !(state === 'pulse-error' && ((e.type === 'http' && e.path === '/api/couple/pulse' && e.status === 503) || (e.type === 'console' && /503/.test(e.message)))));
      assert.equal(unexpected.length, 0, 'Unexpected browser errors');
      checks.push(`${state} ${viewport.width}: headings and state checked; three viewport captures`);
      await context.close();
    }
    await h.writeResult({ ok: true, checks, inventory, limitations: ['Synthetic browser GET fixtures; no backend population, login-flow or mutation proof', 'Pulse failure is injected; dependent live requests remain real', 'Screenshots require manual visual review; selected cases only'] });
    console.log(`PASS ${checks.length} cases; ${inventory.length} captures; ${h.evidenceDir}`);
  } catch {
    // Failure details may contain private fixture values; never write or print them.
    await h.writeResult({ ok: false, checks, inventory, failure: 'Home state verification failed; inspect locally without publishing sensitive values.' });
    console.error('Home state verification failed; inspect locally without publishing sensitive values.');
    process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
