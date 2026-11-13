// Local synthetic visual inventory, not a replacement for interaction/money suites.
// Existing private baseline fixture is required. No credential/state/trace artifacts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-matrix-${Date.now()}`);
const h = await import('./harness.mjs');
const inventory = [], errors = [], guards = [];
let browser;
const windows = [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }];
async function setup(route, token, body) {
  h.assert(/^\/(?:auth\/(?:login|register)|me|questions\/today|letters|savings(?:\/propose)?|proposals\/[a-f\d]{24}\/approve|friends\/(?:outings|invites))$/.test(route), 'Unexpected visual setup route');
  const response = await fetch(`${h.apiURL}/api${route}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); h.assert(response.ok, `Visual setup ${route}: ${response.status}`); return data.data;
}
async function capture(page, id, route, viewport, state) {
  await page.setViewportSize(viewport);
  await page.goto(`${h.baseURL}${route}`);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  h.assert.equal(new URL(page.url()).pathname, route, `${id}: capture must remain on its expected route`);
  h.assert(await page.locator('h1').count() > 0, `${id}: rendered page needs a heading`);
  await h.noOverflow(page);
  const name = `${id}-${viewport.width}-${state}`;
  await h.screenshot(page, name);
  const diagnostic = await page.evaluate(() => ({ title: document.title, headings: [...document.querySelectorAll('h1,h2')].map(el => el.textContent),
    buttonsBelow44px: [...document.querySelectorAll('button,a.btn')].filter(el => { const b = el.getBoundingClientRect(); return b.width && b.height && (b.width < 44 || b.height < 44); }).map(el => ({ text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,60), height: Math.round(el.getBoundingClientRect().height) })).slice(0,30) }));
  inventory.push({ id, route: route.replace(/[a-f\d]{24}/g, ':id'), viewport, state, screenshot: `${name}.png`, diagnostic,
    review: 'capture only; manual image review required', otherStates: 'loading/error/empty/pending require separate evidence, not inferred' });
  console.log(`CAPTURE ${id} ${viewport.width} ${state}`);
}
try {
  h.assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
  const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
  h.assert(fixture.synthetic && fixture.users?.length === 2, 'Synthetic paired fixture required');
  const user = fixture.users[0];
  const tokens = await setup('/auth/login', undefined, { email: user.email, password: user.password });
  const question = await setup('/questions/today', tokens.accessToken);
  const savings = await setup('/savings', tokens.accessToken);
  if (!savings.items.length) {
    const partner = await setup('/auth/login', undefined, { email: fixture.users[1].email, password: fixture.users[1].password });
    const proposal = await setup('/savings/propose', tokens.accessToken, { title: 'Quỹ mẫu kiểm tra giao diện', emoji: '💰', targetVnd: 1000000 });
    await setup(`/proposals/${proposal.id}/approve`, partner.accessToken, {});
    Object.assign(savings, await setup('/savings', tokens.accessToken));
  }
  const invite = await setup('/friends/invites', tokens.accessToken, { days: 1, maxUses: 5 });
  const unpaired = await setup('/auth/register', undefined, { email: `visual-${randomUUID()}@example.test`, password: `Synthetic-${randomUUID()}`, displayName: 'Người mới kiểm thử' });
  // Visual-only fixture mutations above do not count as UI money-flow evidence.
  const openOn = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const letter = await setup('/letters', tokens.accessToken, { title: 'Một lá thư mẫu', body: 'Nội dung synthetic để kiểm tra bố cục. Không có dữ liệu thật.', openOn });
  const outing = await setup('/friends/outings', tokens.accessToken, { operationId: randomUUID(), expectedRevision: 0, title: 'Buổi gặp mặt mẫu với tên dài để kiểm tra bố cục', outingDate: openOn, inviteeIds: [] });
  browser = await h.openBrowser();
  const sessions = {};
  for (const space of ['couple','friends','public','unpaired']) {
    sessions[space] = await h.fresh(browser, space, errors);
    if (space !== 'public') await sessions[space].context.addInitScript(({ tokens, space }) => {
      // Seed once per context, not every navigation: refresh rotation must survive reloads.
      if (!sessionStorage.getItem('v12.matrix.seeded')) {
        localStorage.setItem('lw.accessToken', tokens.accessToken); localStorage.setItem('lw.refreshToken', tokens.refreshToken); localStorage.setItem('lw.space', space);
        sessionStorage.setItem('v12.matrix.seeded', '1');
      }
    }, { tokens: space === 'unpaired' ? unpaired : tokens, space: space === 'unpaired' ? 'couple' : space });
  }
  const routes = [
    ['R01','/login','public'], ['R03','/pairing','unpaired'], ['R04',`/j/${invite.code}`,'public'], ['R05','/install','public'],
    ['R07','/','couple'],['R08','/quests','couple'],['R09','/quests/water','couple'],['R11','/quests/bucket','couple'],['R12','/approvals','couple'],
    ['R13','/stories','couple'],['R14',`/stories/${fixture.storyId}`,'couple'],['R15','/market','couple'],['R16','/finance','couple'],['R17','/savings','couple'],
    ['R19','/finance/guide','couple'],['R20','/finance/assistant','couple'],['R21','/questions','couple'],['R22',`/questions/${question.id}`,'couple'],
    ['R23','/events','couple'],['R24','/letters','couple'],['R25',`/letters/${letter.id}`,'couple'],['R26','/moments','couple'],['R27','/profile','couple'],
    ['R28','/profile/notifications','couple'],['R29','/profile/moods','couple'],['R30','/friends','friends'],['R31','/friends/people','friends'],
    ['R32',`/friends/posts/${fixture.postId}`,'friends'],['R33','/friends/events','friends'],['R34',`/friends/events/${fixture.eventId}`,'friends'],
    ['R35','/friends/notifications','friends'],['R36',`/friends/u/${fixture.users[1].id}`,'friends'],['R37','/friends/me','friends'],
    ['R38','/friends/me/blocked','friends'],['R39','/friends/me/invites','friends'],['R40','/friends/me/notifications','friends'],
    ['N01','/friends/outings','friends'],['N02',`/friends/outings/${outing.outing.id}`,'friends'],
  ];
  if (savings.items[0]) routes.push(['R18',`/savings/${savings.items[0].id}`,'couple']);
  else inventory.push({ id:'R18', status:'missing-populated-fixture', review:'PENDING', reason:'Baseline fixture has no savings goal. Use CP7 suite evidence; do not fabricate a detail capture.' });
  for (const viewport of windows) {
    // Each navigation creates several expensive reads. Pace batches below the
    // unchanged per-user sliding-minute budget, including setup and shell reads.
    let captured = 0;
    for (const [id,route,space] of routes) {
      if (captured > 0 && captured % 8 === 0) await new Promise(resolve => setTimeout(resolve, 62000));
      await capture(sessions[space].page,id,route,viewport,id==='R04'?'valid-invite':id==='R03'?'unpaired':'current-synthetic');
      captured++;
    }
    await new Promise(resolve => setTimeout(resolve, 62000));
    for (const space of ['couple', 'friends', 'unpaired']) {
      const page = sessions[space].page;
      // Normal refresh before the next long viewport pass; no TTL overrides or 401 allowance.
      const refreshed = await page.evaluate(async () => {
        const refreshToken = localStorage.getItem('lw.refreshToken');
        if (!refreshToken) return false;
        const response = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }), cache: 'no-store' });
        if (!response.ok) return false;
        const { data } = await response.json();
        localStorage.setItem('lw.accessToken', data.accessToken);
        localStorage.setItem('lw.refreshToken', data.refreshToken);
        return true;
      });
      h.assert(refreshed, 'Normal matrix session refresh failed');
    }
  }
  for (const viewport of windows) {
    const page = sessions.public.page;
    await page.goto(`${h.baseURL}/j/${invite.code}`);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/friends/login');
    await page.setViewportSize(viewport);
    await h.noOverflow(page);
    const screenshot = `R02-${viewport.width}-invite-unlocked`;
    await h.screenshot(page, screenshot);
    inventory.push({ id:'R02',route:'/friends/login',viewport,state:'invite-unlocked',screenshot:`${screenshot}.png`,review:'capture only; manual image review required' });
  }
  for (const [id,space,route,target] of [['R02','public','/friends/login','/login'],['R03','couple','/pairing','/'],['R06','couple','/v12-unknown-route','/'],['R10','couple','/water','/quests/water']]) {
    // A same-URL reload can retain unlocked history state. Bare-route guard must
    // use a fresh history entry/context, not the just-captured invite login.
    const bare = id === 'R02' ? await h.fresh(browser, 'bare-guard', errors) : null;
    const page = bare?.page ?? sessions[space].page; await page.goto(`${h.baseURL}${route}`); await page.waitForURL(url => url.pathname === target);
    await bare?.context.close();
    guards.push({ id, route, target, passed:true, scope:id==='R03'?'paired redirect only; unpaired page still pending':id==='R02'?'bare guard only; unlocked page covered by boat suite':'redirect target only; full history matrix pending' });
  }
  h.assert.equal(errors.length,0,'Unexpected browser errors recorded');
  await h.writeResult({ ok:true, inventory, guards, errors, scope:'Route/default-state visual inventory only. Finance API calls seed visual data, not money interaction acceptance.',
    limitations:['No complete loading/empty/error/pending state matrix','Images must be opened and reviewed; captures are not visual acceptance','44px diagnostics need manual contextual review; no contrast/CLS claim','Synthetic savings goal approved through setup API for visual inventory only, not money UI evidence'] });
  console.log(`PASS ${inventory.filter(row=>row.screenshot).length} captures; evidence ${h.evidenceDir}`);
} catch(error) {
  await h.writeResult({ok:false,inventory,guards,errors,failure:h.sanitize(error.message)});
  console.error(h.sanitize(error.message));process.exitCode=1;
} finally { await browser?.close(); }
