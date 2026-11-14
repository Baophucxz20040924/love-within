// Browser-only synthetic GET states. No server mutations except baseline login.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { classify } from './v12-content-states.mjs';

const at = '2026-11-13T02:00:00.000Z';
const id = n => n.toString(16).padStart(24, '0');
export function fixtures(owner, partner) {
  const title = 'Món quà dài để kiểm tra xuống dòng trên điện thoại và màn hình lớn';
  const item = (n, isMine) => ({ id: id(n), title, description: 'Phần thưởng mẫu', emoji: '🎁', priceCoin: 1000000, createdBy: isMine ? owner.id : partner.id, isMine, status: 'available', createdAt: at });
  const items = [item(1, false), item(2, true)];
  const redemption = (n, isBuyer, status) => ({ id: id(10 + n), itemId: items[isBuyer ? 0 : 1].id, itemTitle: title, itemEmoji: '🎁', priceCoin: 1000000, buyerUserId: isBuyer ? owner.id : partner.id, sellerUserId: isBuyer ? partner.id : owner.id, buyerName: isBuyer ? owner.displayName : partner.displayName, sellerName: isBuyer ? partner.displayName : owner.displayName, isBuyer, status, responseNote: null, createdAt: at, respondedAt: status === 'requested' ? null : at, fulfilledAt: status === 'fulfilled' ? at : null });
  const redemptions = [redemption(1, true, 'requested'), redemption(2, true, 'accepted'), redemption(3, false, 'accepted'), redemption(4, true, 'fulfilled'), redemption(5, false, 'requested')];
  const invites = [
    { id: id(30), code: 'syntheticActive123', maxUses: 5, uses: 1, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: at, status: 'active' },
    { id: id(31), code: 'syntheticExpired123', maxUses: 5, uses: 0, expiresAt: '2020-01-01T00:00:00.000Z', createdAt: at, status: 'expired' },
    { id: id(32), code: 'syntheticUsed123', maxUses: 1, uses: 1, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: at, status: 'used_up' },
  ];
  const pairing = ['received', 'sent'].map((direction, i) => ({ id: id(40 + i), fromUserId: partner.id, fromDisplayName: partner.displayName, toEmail: 'synthetic@example.test', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: at, direction }));
  return { items, redemptions, invites, pairing };
}
export function validate(f) {
  assert.deepEqual(f.invites.map(i => i.status), ['active', 'expired', 'used_up']);
  assert.deepEqual(f.pairing.map(i => i.direction), ['received', 'sent']);
  assert(f.items.some(i => i.isMine) && f.items.some(i => !i.isMine));
  assert(f.redemptions.some(r => r.isBuyer && r.status === 'requested'));
  assert(f.redemptions.some(r => r.isBuyer && r.status === 'accepted'));
  assert(f.redemptions.some(r => !r.isBuyer && r.status === 'accepted'));
  assert(f.redemptions.some(r => r.status === 'fulfilled'));
}

async function main() {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_pw', 'shots', `v12-family-states-${Date.now()}`);
  const h = await import('./harness.mjs');
  const checks = [], inventory = [], errors = [], blocked = [], faults = [];
  const limitations = ['Synthetic GET DTO display only, not API, authorization, persistence or mutation proof', 'Pairing unpaired identity is synthesized from baseline /me, not real unpairing', 'Screenshots require manual visual review; no visual acceptance implied', 'Only create failure is simulated; no real mutation is sent'];
  let browser;
  try {
    assert(process.env.LW_BASELINE_FIXTURE, 'LW_BASELINE_FIXTURE required');
    const baseline = JSON.parse(await readFile(process.env.LW_BASELINE_FIXTURE, 'utf8'));
    assert(baseline.synthetic && baseline.users?.length === 2, 'Existing synthetic paired/friends baseline required');
    const [owner, partner] = baseline.users;
    const login = await h.api('POST', '/auth/login', { email: owner.email, password: owner.password });
    const me = await h.api('GET', '/me', undefined, login.accessToken);
    assert.equal(me.user.id, owner.id);
    assert(me.user.coupleId && me.couple, 'Paired baseline required');
    const f = fixtures(owner, partner); validate(f);
    browser = await h.openBrowser();
    for (const viewport of [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      for (const scenario of ['market-populated', 'market-empty', 'market-seller-only', 'pairing', 'invites']) {
        const label = `${scenario}-${viewport.width}`;
        const { context, page } = await h.fresh(browser, label, errors);
        try {
          await page.setViewportSize(viewport);
          await context.addInitScript(({ login, space }) => { localStorage.setItem('lw.accessToken', login.accessToken); localStorage.setItem('lw.refreshToken', login.refreshToken); localStorage.setItem('lw.space', space); }, { login, space: scenario === 'invites' ? 'friends' : 'couple' });
          if (scenario === 'invites') await context.addInitScript(() => {
            Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('synthetic clipboard failure'); } }, configurable: true });
          });
          let getCount = 0, createFaults = 0;
          let mutation = null;
          const heldFailure = async (method, urlPath, trigger, control, shot) => {
            let release, arrived; const gate = new Promise(r => release = r), arrival = new Promise(r => arrived = r);
            mutation = { method, path: urlPath, gate, arrived, count: 0 };
            try {
              await trigger(); let timer;
              try { await Promise.race([arrival,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Expected family mutation not observed')),12000))]); } finally { clearTimeout(timer); }
              await page.waitForFunction(el=>el.matches(':disabled'),await control.elementHandle());
              assert.equal(mutation.count,1);await control.scrollIntoViewIfNeeded();await shot('pending-disabled');
              release();await page.getByText('Lỗi family kiểm thử',{exact:true}).waitFor();assert.equal(mutation.count,1);
              faults.push({label,path:urlPath,status:503,count:1});await shot('mutation-error');
            } finally { release(); mutation = null; }
          };
          await context.route('**/api/**', async route => {
            const request = route.request(), pathname = new URL(request.url()).pathname;
            if (request.method() === 'POST' && pathname === '/api/market/seen' && scenario.startsWith('market-')) {
              return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) });
            }
            if (request.method() !== 'GET') {
              if (mutation && request.method() === mutation.method && pathname === mutation.path) {
                mutation.count++;mutation.arrived();await mutation.gate;
                return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'Lỗi family kiểm thử'}})});
              }
              if (scenario === 'invites' && pathname === '/api/friends/invites' && request.method() === 'POST') {
                createFaults++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: 'Tạm thời không thể tạo link' } }) });
              }
              blocked.push({ scenario, method: request.method(), path: pathname }); return route.abort();
            }
            let data;
            if (scenario === 'pairing' && pathname === '/api/me') data = { ...me, user: { ...me.user, coupleId: null }, couple: null };
            else if (scenario === 'pairing' && pathname === '/api/pairing/invites') data = f.pairing;
            else if (scenario.startsWith('market-') && pathname === '/api/market/items') data = scenario === 'market-empty' ? [] : f.items;
            else if (scenario.startsWith('market-') && pathname === '/api/market/redemptions') data = scenario === 'market-empty' ? [] : scenario === 'market-seller-only' ? f.redemptions.filter(r => !r.isBuyer) : f.redemptions;
            else if (scenario === 'invites' && pathname === '/api/friends/invites') data = f.invites;
            else return route.continue();
            getCount++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
          });
          const shot = async name => {
            await page.evaluate(() => document.fonts.ready); await h.noOverflow(page);
            const file = `${label}-${name}`; await h.screenshot(page, file, { fullPage: false });
            inventory.push({ scenario, viewport, state: name, screenshot: `${file}.png`, review: 'pending manual review' });
          };
          if (scenario.startsWith('market-')) {
            await page.goto(`${h.baseURL}/market`);
            if (scenario === 'market-empty') await page.getByText(/chưa đăng món nào/).waitFor();
            else await page.getByText(f.items[0].title).first().waitFor();
            await shot('shop');
            await page.getByRole('radio', { name: 'Gian hàng tôi' }).click();
            await page.getByRole('button', { name: /Đăng món mới/ }).waitFor();
            if (scenario !== 'market-empty') await page.getByText(f.items[1].title).first().waitFor();
            await shot('mine');
            await page.getByRole('radio', { name: /^Đã đổi/ }).click();
            if (scenario === 'market-empty' || scenario === 'market-seller-only') await page.getByText('Chưa đổi món nào', { exact: true }).waitFor();
            else { await page.getByText('Chờ thực hiện', { exact: false }).first().waitFor(); await page.getByRole('heading', { name: 'Lịch sử' }).waitFor(); }
            await shot('history');
          } else if (scenario === 'pairing') {
            await page.goto(`${h.baseURL}/pairing`);
            await page.getByRole('heading', { name: 'Lời mời dành cho bạn' }).waitFor();
            await page.getByRole('heading', { name: 'Đã gửi' }).waitFor();
            assert(await page.getByRole('button', { name: /Chấp nhận/ }).isEnabled());
            await shot('pending');
            const input=page.getByLabel('Email người ấy');await input.fill('synthetic@example.test');
            const submit=page.getByRole('button',{name:'Gửi lời mời',exact:true});
            await heldFailure('POST','/api/pairing/invite',()=>submit.click(),submit,shot);
            assert.equal(await input.inputValue(),'synthetic@example.test');
            const feedback=page.getByRole('alert');await feedback.scrollIntoViewIfNeeded();await shot('send-error-retained');
          } else {
            await page.goto(`${h.baseURL}/friends/me/invites`);
            await page.getByText('/j/syntheticActive123', { exact: true }).waitFor();
            await page.getByText('Hết hạn', { exact: true }).waitFor();
            await page.getByText('Đã đủ 1 người', { exact: true }).waitFor();
            await shot('statuses');
            await page.getByRole('button', { name: 'Chia sẻ link', exact: true }).click();
            const fallback = page.getByLabel('Link để sao chép');
            await fallback.waitFor(); assert.equal(await fallback.inputValue(), `${h.baseURL}/j/syntheticActive123`); assert.equal(await fallback.getAttribute('readonly'), '');
            await fallback.focus(); await shot('clipboard-failure');
            await page.getByRole('button', { name: 'Tạo link mời' }).click();
            await page.getByText('Tạm thời không thể tạo link', { exact: true }).waitFor();
            assert.equal(createFaults, 1); await shot('create-503');
            faults.push({label,path:'/api/friends/invites',status:503,count:1});
            const revoke=page.getByRole('button',{name:'Thu hồi',exact:true});
            await revoke.scrollIntoViewIfNeeded();await heldFailure('DELETE',`/api/friends/invites/${f.invites[0].id}`,()=>revoke.click(),revoke,shot);
            await page.getByText('/j/syntheticActive123',{exact:true}).waitFor();
          }
          assert(getCount > 0, 'Synthetic GET must be observed');
          checks.push(`${label}: synthetic GET states and assertions completed`);
        } finally { await context.close(); }
      }
    }
    classify(errors,faults);
    assert(blocked.every(b => b.method === 'POST' && b.path === '/api/market/seen'), `Unexpected blocked mutations: ${JSON.stringify(blocked)}`);
    await h.writeResult({ ok: true, checks, inventory, errors, blocked, limitations });
  } catch (error) {
    const failure = h.sanitize(String(error?.message || error).split('\nCall log:')[0]);
    await h.writeResult({ ok: false, checks, inventory, errors, blocked, failure, limitations }); console.error(failure); process.exitCode = 1;
  } finally { await browser?.close(); }
}
if (process.argv.includes('--validate')) {
  validate(fixtures({ id: id(900), displayName: 'An' }, { id: id(901), displayName: 'Bình' }));
  console.log('PASS pure market/pairing/invite fixtures; browser not run');
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
