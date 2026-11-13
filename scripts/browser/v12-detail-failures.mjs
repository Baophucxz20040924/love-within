// Prepared visual checks for detail routes. No setup mutations except ordinary login.
// Requires the shared v12 harness and a private synthetic baseline fixture.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const faultMessage = status => new RegExp(`^Failed to load resource: the server responded with a status of ${status} \\([^)]*\\)$`);
function classify(errors, faults) {
  const remaining = new Map();
  for (const f of faults) for (const type of ['http', 'console']) remaining.set(`${f.label}|${type}|${f.path}|${f.status}`, f.count);
  const unexpected = [];
  for (const e of errors) {
    const status = e.type === 'http' ? e.status : e.type === 'console' ? Number(/^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(e.message)?.[1]) : 0;
    const key = `${e.label}|${e.type}|${e.path}|${status}`;
    if ((e.type === 'http' || (e.type === 'console' && faultMessage(status).test(e.message))) && (remaining.get(key) || 0) > 0) remaining.set(key, remaining.get(key) - 1);
    else unexpected.push(e);
  }
  assert.deepEqual(unexpected, [], 'Unexpected browser errors');
  assert.deepEqual([...remaining].filter(([, count]) => count !== 0), [], 'Controlled response or resource console count mismatch');
}
if (process.argv.includes('--validate')) {
  const f = [{label:'detail', path:'/api/stories/1', status:503, count:2}];
  const good = Array.from({length:2}, () => [{label:'detail',type:'http',path:'/api/stories/1',status:503}, {label:'detail',type:'console',path:'/api/stories/1',message:'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'}]).flat();
  classify(good, f);
  assert.throws(() => classify(good.slice(1), f));
  assert.throws(() => classify([...good, {...good[0], path:'/api/me'}], f));
  console.log('Pure fault classifier validation passed');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-detail-failures-${Date.now()}`);
  const h = await import('./harness.mjs');
  const errors = [], faults = [], checks = [], skips = [], held = [];
  let browser;
  async function get(route, token) {
    assert(['/savings', '/questions/today', '/friends/outings'].includes(route));
    const response = await fetch(`${h.apiURL}/api${route}`, {headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(20000)});
    assert(response.ok, `Setup GET ${route}: ${response.status}`);
    return (await response.json()).data;
  }
  async function fresh(label, user, space) {
    // Each context gets its own normal login and seeds its rotating pair only once.
    const tokens = await h.api('POST', '/auth/login', {email:user.email, password:user.password});
    const session = await h.fresh(browser, label, errors);
    await session.context.addInitScript(({tokens, space}) => {
      if (!sessionStorage.getItem('v12.detail.seeded')) {
        localStorage.setItem('lw.accessToken', tokens.accessToken);
        localStorage.setItem('lw.refreshToken', tokens.refreshToken);
        localStorage.setItem('lw.space', space);
        sessionStorage.setItem('v12.detail.seeded', '1');
      }
    }, {tokens, space});
    return session;
  }
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const fixture = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(fixture.synthetic && fixture.users?.length === 2, 'Synthetic paired fixture required');
    const user = fixture.users[0];
    const setup = await h.api('POST', '/auth/login', {email:user.email, password:user.password});
    const savings = await get('/savings', setup.accessToken);
    const question = await get('/questions/today', setup.accessToken);
    const outings = await get('/friends/outings', setup.accessToken);
    const id = value => { assert(typeof value === 'string' && /^[a-f\d]{24}$/i.test(value), 'Expected synthetic fixture id'); return value; };
    const targets = [
      ...(savings.items?.length ? [{name:'savings', id:id(savings.items[0].id), route:'/savings/', api:'/api/savings/', space:'couple', heading:'Chi tiết quỹ', success:'.savings-card'}] : []),
      {name:'story', id:id(fixture.storyId), route:'/stories/', api:'/api/stories/', space:'couple', heading:'Bài viết', success:'.page article.post', missing:'Bài viết không còn nữa'},
      {name:'question', id:id(question.id), route:'/questions/', api:'/api/questions/', space:'couple', heading:'Câu hỏi', success:'.q-detail', missing:'Không tìm thấy câu hỏi'},
      {name:'friend-post', id:id(fixture.postId), route:'/friends/posts/', api:'/api/friends/stories/', space:'friends', heading:'Bài viết', success:'.page article.post', missing:'Bài viết không còn nữa'},
      {name:'friend-event', id:id(fixture.eventId), route:'/friends/events/', api:'/api/friends/events/', space:'friends', heading:'Kèo', success:'.fev-detail__title', missing:'Kèo không còn nữa'},
      ...(outings.items?.length ? [{name:'outing', id:id(outings.items[0].id), route:'/friends/outings/', api:'/api/friends/outings/', space:'friends', heading:'Buổi chia tiền', success:'.outing-hero, .outing-invitation'}] : []),
    ];
    if (!savings.items?.length) skips.push('savings: no existing baseline goal; no money setup performed');
    if (!outings.items?.length) skips.push('outing: no existing visible outing; no synthetic response or mutation performed');
    browser = await h.openBrowser();
    const captureNames = new Set(['savings','story','friend-event','outing']);
    async function capture(page, name, state) {
      if (!captureNames.has(name)) return;
      for (const viewport of [{width:360,height:780},{width:1280,height:900}]) {
        await page.setViewportSize(viewport); await h.noOverflow(page);
        await h.screenshot(page, `${name}-${state}-${viewport.width}`, {fullPage:false});
      }
    }
    for (const t of targets) {
      const label = `${t.name}-503`, apiPath = t.api + t.id;
      const {context,page} = await fresh(label, user, t.space);
      let release, mode = 'held', failures = 0, normal = 0;
      const gate = new Promise(resolve => { release = resolve; }); held.push(release);
      await page.route('**/api/**', async route => {
        const req = route.request();
        if (req.method() !== 'GET' || new URL(req.url()).pathname !== apiPath) return route.continue();
        if (mode === 'held') await gate;
        if (mode === 'normal') { normal++; return route.continue(); }
        failures++;
        return route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:{code:'V12_CONTROLLED_FAILURE',message:'Lỗi kiểm thử tải dữ liệu'}})});
      });
      await page.goto(h.baseURL + t.route + t.id);
      await page.getByRole('heading',{name:t.heading,exact:true}).waitFor();
      await page.locator('.page [aria-busy="true"]').first().waitFor();
      await capture(page,t.name,'loading');
      mode = 'failure'; release();
      const alert = page.getByRole('alert').filter({hasText:t.name === 'outing' ? 'Chưa cập nhật được sổ' : 'Không tải được dữ liệu'});
      await alert.waitFor();
      assert.equal(failures, 2, 'Initial request plus one automatic query retry must fail');
      await capture(page,t.name,'error');
      mode = 'normal';
      await alert.getByRole('button',{name:'Thử lại',exact:true}).click();
      await page.locator(t.success).first().waitFor();
      await alert.waitFor({state:'hidden'});
      assert.equal(normal,1,'Exactly one real GET after manual retry');
      faults.push({label,path:apiPath,status:503,count:2});
      checks.push({name:t.name,loading:true,failures:2,manualRetryRealGets:normal});
      await context.close();
      if (t.missing) {
        const missingLabel = `${t.name}-missing`;
        const missing = await fresh(missingLabel,user,t.space); let count = 0;
        await missing.page.route('**/api/**', async route => {
          if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== apiPath) return route.continue();
          count++; return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND',message:'Không tìm thấy'}})});
        });
        await missing.page.goto(h.baseURL+t.route+t.id);
        await missing.page.getByRole('heading',{name:t.heading,exact:true}).waitFor();
        const boundary = missing.page.getByRole('alert').filter({hasText:t.missing});
        await boundary.waitFor();
        assert.equal(await boundary.getByRole('button',{name:'Thử lại'}).count(),0,'Not-found boundary must not offer retry');
        assert.equal(count,1,'404 must not auto-retry');
        faults.push({label:missingLabel,path:apiPath,status:404,count:1});
        checks.push({name:t.name,state:'synthetic-404-not-found',requests:count});
        await missing.context.close();
      }
    }
    classify(errors,faults);
    await h.writeResult({ok:true,checks,skips,errors,limitations:['Synthetic injected 404 is a not-found boundary, not a proven empty collection','Only existing savings and outing fixtures are used','Screenshots require manual review; not real device or visual acceptance']});
    console.log(`Completed ${checks.length} checks; manual review required; evidence ${h.evidenceDir}`);
  } catch (error) {
    await h.writeResult({ok:false,checks,skips,errors,failure:h.sanitize(error.message)});
    console.error(h.sanitize(error.message)); process.exitCode=1;
  } finally { held.forEach(resolve => resolve()); await browser?.close(); }
}
