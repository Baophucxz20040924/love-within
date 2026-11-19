// Fail-closed synthetic story/event UI verification; no API/DB/provider is used.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fixtures, fixedTime } from './daily-rewards-water.mjs';
const id = n => n.toString(16).padStart(24, '0');
function data() {
  const f = fixtures();
  const event = { id: id(940), creator: f.users[0], isMine: true, title: 'Kèo synthetic kiểm tra thảo luận', startAt: '2099-11-19T12:00:00.000Z', endAt: null, pastAt: '2099-11-19T18:00:00.000Z', past: false, place: '', mapUrl: null, description: '', cover: null, status: 'active', myRsvp: 'going', counts: { going: 1, maybe: 0, declined: 0, pending: 0 }, goingPreview: [f.users[0]], commentCount: 100, editedAt: null, createdAt: fixedTime, invitedIds: [], guests: { going: [{ ...f.users[0], isCreator: true }], maybe: [], declined: [], pending: [] } };
  const comment = (n, parentId = null) => ({ id: id(n), parentId, author: f.users[0], body: `${parentId ? 'Trả lời' : 'Gốc'} mẫu ${n}`, mentions: [], canMentionAuthor: true, isMine: true, canDelete: true, createdAt: fixedTime });
  const roots = Array.from({ length: 40 }, (_, i) => comment(1000 - i));
  roots[19] = { ...roots[19], author: f.users[1], isMine: false };
  const replies = Array.from({ length: 60 }, (_, i) => comment(2000 - i, roots[19].id));
  const story = { id: id(500), author: f.users[0], isMine: true, body: 'Bài viết synthetic kiểm tra thảo luận', photos: [], videos: [], mentions: [], poll: null, reactions: { counts: {}, mine: null, total: 0 }, commentCount: 100, createdAt: fixedTime, editedAt: null };
  return { ...f, story, event, roots, replies };
}
if (process.argv.includes('--validate')) {
  const f = data(); assert.equal(new Set([...f.roots, ...f.replies].map(c => c.id)).size, 100);
  assert(f.replies.every(c => c.parentId === f.roots[19].id));
  console.log('PASS Friends comment fixtures; no browser/network imported');
} else {
  process.env.LW_EVIDENCE_DIR ||= path.join(os.tmpdir(), 'lw_friend_comments', `${Date.now()}`);
  const h = await import('./harness.mjs');
  const checks = [], errors = [], faults = [], blocked = [], requests = [], inventory = [];
  let browser, activePage, stage, closing = false;
  const json = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: value }) });
  const until = async (fn, message) => { const start = Date.now(); while (!await fn()) { assert(Date.now() - start < 12000, message); await new Promise(r => setTimeout(r, 40)); } };
  const shot = async (page, name) => { await h.noOverflow(page); await h.screenshot(page, name, { fullPage: false }); inventory.push(`${name}.png`); };
  try {
    browser = await h.openBrowser();
    for (const [device, viewport] of [['mobile', { width: 360, height: 780 }], ['desktop', { width: 1280, height: 800 }]]) for (const kind of ['stories', 'events']) {
      const label = `${device}-${kind}`, f = data(), resource = kind === 'stories' ? f.story : f.event;
      const base = `/api/friends/${kind}/${resource.id}`, ui = kind === 'stories' ? `/friends/posts/${resource.id}` : `/friends/events/${resource.id}`;
      const s = { failAdd: true, added: null, replyAdded: null, deleted: new Set(), emptyOld: false, denied: false };
      const context = await browser.newContext({ viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(() => { localStorage.setItem('lw.sessionGeneration', JSON.stringify({ id: 'synthetic-thread', tokens: { accessToken: 'synthetic', refreshToken: 'synthetic-refresh' } })); localStorage.setItem('lw.space', 'friends'); });
      await context.routeWebSocket('**/*', socket => socket.onMessage(() => {}));
      await context.route('**/*', async route => {
        try {
          const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
          if (url.origin !== h.baseURL) { blocked.push({ label, method, path: p }); return route.abort('blockedbyclient'); }
          // Preview's fallback can reject a document URL with a comment query.
          // Serve only this synthetic UI document from the same local index.
          if (req.isNavigationRequest() && p === ui && method === 'GET') return route.fulfill({ response: await route.fetch({ url: `${h.baseURL}/` }) });
          if (!p.startsWith('/api/') && method === 'GET') return route.continue();
          requests.push({ label, method, path: p });
          const fault = status => { faults.push({ label, path: p, status }); return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_FAULT', message: 'Lỗi thử nghiệm' } }) }); };
          if (method === 'GET') {
            if (p === '/api/me') return json(route, { user: f.users[0], couple: f.couple, wallet: null, exp: 125, level: 2 });
            if (p === '/api/privacy-lock') return json(route, { friends: false, couple: false, revision: 1 });
            if (p === '/api/push/config') return json(route, { enabled: false, publicKey: null });
            if (p === '/api/friends/unread') return json(route, { notifications: 0, notificationsSaturated: false, friendRequests: 0, messages: 0 });
            if (p === '/api/realtime') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic\n\n' });
            if (p === base) return json(route, resource);
            if (p === '/api/friends/outings' && url.searchParams.get('eventId') === resource.id) return json(route, { items: [], nextCursor: null });
            if (p === `${base}/mentionable`) return json(route, []);
            if (p === `${base}/comments/page`) {
              assert.equal(url.searchParams.get('limit'), '20'); if (s.denied) return fault(403);
              const old = url.searchParams.has('cursor');
              const rows = old ? (s.emptyOld ? [] : f.roots.slice(20)) : [...(s.added ? [s.added] : []), ...f.roots].slice(0, 20);
              return json(route, { items: rows.filter(c => !s.deleted.has(c.id)), nextCursor: old ? null : 'roots-old' });
            }
            if (p.startsWith(`${base}/comments/`) && p.endsWith('/context')) {
              if (s.denied) return fault(403);
              const target = p.split('/').at(-2), reply = f.replies.find(c => c.id === target), root = f.roots.find(c => c.id === (reply?.parentId ?? target)); assert(root);
              const start = reply ? f.replies.indexOf(reply) : 0;
              return json(route, { root, replies: { items: [...(start === 0 && s.replyAdded ? [s.replyAdded] : []), ...f.replies.slice(start, start + 20)].slice(0, 20).filter(c => !s.deleted.has(c.id)), nextCursor: start < 40 ? `replies-${start + 20}` : null } });
            }
            if (p.startsWith(`${base}/comments/`) && p.endsWith('/replies/page')) {
              if (s.denied) return fault(403);
              const start = Number(url.searchParams.get('cursor')?.split('-')[1] ?? 0);
              return json(route, { items: [...(start === 0 && s.replyAdded ? [s.replyAdded] : []), ...f.replies.slice(start, start + 20)].slice(0, 20).filter(c => !s.deleted.has(c.id)), nextCursor: start < 40 ? `replies-${start + 20}` : null });
            }
          }
          if (p === '/api/friends/reports' && method === 'POST') return json(route, { ok: true });
          if (p === '/api/friends/blocks' && method === 'POST') return json(route, { ok: true });
          if (p === `${base}/comments` && method === 'POST') {
            if (s.failAdd) return fault(503);
            const input = req.postDataJSON(), row = { ...f.roots[0], id: id(input.parentId ? 3001 : 3000), body: input.body, parentId: input.parentId ?? null };
            if (input.parentId) s.replyAdded = row; else s.added = row;
            return json(route, row);
          }
          if (p.startsWith(`${base}/comments/`) && method === 'DELETE') { const target = p.split('/').at(-1); s.deleted.add(target); if (f.roots.slice(20).some(c => c.id === target)) s.emptyOld = true; return json(route, { ok: true, removed: 1 }); }
          blocked.push({ label, method, path: p }); return route.abort('blockedbyclient');
        } catch (error) { errors.push({ label, type: 'mock', message: h.sanitize(error.message) }); await route.abort('failed').catch(() => {}); }
      });
      const page = activePage = await context.newPage(); page.setDefaultTimeout(12000); await page.clock.setFixedTime(new Date(fixedTime));
      page.on('pageerror', e => errors.push({ label, type: 'pageerror', message: h.sanitize(e.message) }));
      page.on('response', r => { if (r.status() >= 400) errors.push({ label, type: 'http', path: new URL(r.url()).pathname, status: r.status() }); });
      page.on('console', m => { if (m.type() === 'error') { let p; try { p = new URL(m.location().url).pathname; } catch {} errors.push({ label, type: 'console', path: p, message: h.sanitize(m.text()) }); } });
      page.on('requestfailed', r => { if (!closing && r.failure()?.errorText !== 'net::ERR_ABORTED') errors.push({ label, type: 'requestfailed', path: new URL(r.url()).pathname }); });
      stage = `${label}:roots-replies-history`;
      await page.goto(h.baseURL + ui);
      const section = page.getByRole('region', { name: 'Bình luận', exact: true });
      await until(() => section.locator('.comment').count().then(n => n === 20), '20 roots');
      assert.equal(await section.locator('.comment__body').first().innerText(), 'Gốc mẫu 981');
      await section.getByRole('button', { name: 'Xem trả lời', exact: true }).first().click();
      const replies = section.locator('.comment-replies'); await until(() => replies.locator('.comment').count().then(n => n === 20), 'lazy replies');
      const replyNav = replies.getByRole('navigation'); await replyNav.getByRole('button', { name: 'Cũ hơn', exact: true }).click();
      await replies.getByText('Trả lời mẫu 1961', { exact: true }).waitFor(); await replyNav.getByRole('button', { name: 'Mới hơn', exact: true }).click();
      await replies.getByText('Trả lời mẫu 2000', { exact: true }).waitFor(); checks.push(stage);
      const rootNav = section.getByRole('navigation').last();
      const input = section.getByRole('textbox'); await input.fill('Giữ nội dung synthetic');
      await rootNav.getByRole('button', { name: 'Cũ hơn', exact: true }).click(); await section.getByText('Gốc mẫu 961', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Giữ nội dung synthetic');
      stage = `${label}:failed-draft-add-from-history`;
      await section.getByRole('button', { name: 'Gửi bình luận', exact: true }).click(); await section.getByRole('alert').waitFor();
      await until(() => section.getByRole('alert').evaluate(el => el === document.activeElement), 'error focus'); assert.equal(await input.inputValue(), 'Giữ nội dung synthetic');
      await shot(page, `${label}-draft-error`); s.failAdd = false;
      await section.getByRole('button', { name: 'Gửi bình luận', exact: true }).click(); await section.locator('.comment__body').filter({ hasText: /^Giữ nội dung synthetic$/ }).waitFor();
      await until(() => input.inputValue().then(v => v === ''), 'cleared success'); checks.push(stage);
      stage = `${label}:delete-empty-history`;
      await section.getByRole('navigation').last().getByRole('button', { name: 'Cũ hơn', exact: true }).click(); await section.getByText('Gốc mẫu 961', { exact: true }).waitFor();
      await section.getByRole('button', { name: 'Xóa', exact: true }).first().click(); await page.getByRole('dialog', { name: 'Xóa bình luận?', exact: true }).getByRole('button', { name: 'Xóa', exact: true }).click();
      await section.getByText('Không có bình luận trong trang này.', { exact: true }).waitFor(); checks.push(stage);
      stage = `${label}:deep-context-navigation-reply`;
      const target = f.replies[30]; await page.goto(`${h.baseURL}${ui}?comment=${target.id}`);
      await page.locator(`#comment-${target.id}.comment--focus`).waitFor(); assert.equal(await section.locator('.comment-thread').count(), 1);
      const contextReplies = section.locator('.comment-replies');
      await contextReplies.getByRole('navigation').getByRole('button', { name: 'Cũ hơn', exact: true }).click(); await contextReplies.getByText('Trả lời mẫu 1941', { exact: true }).waitFor();
      await contextReplies.getByRole('navigation').getByRole('button', { name: 'Mới hơn', exact: true }).click(); await contextReplies.getByText(target.body, { exact: true }).waitFor();
      await shot(page, `${label}-deep-context`);
      await page.locator(`#comment-${target.id}`).getByRole('button', { name: 'Trả lời', exact: true }).click(); await section.getByRole('textbox').fill('Trả lời mới synthetic');
      await section.getByRole('button', { name: 'Gửi bình luận', exact: true }).click(); await section.locator('.comment__body').filter({ hasText: /^Trả lời mới synthetic$/ }).waitFor(); checks.push(stage);
      stage = `${label}:delete-reply-live-denial`;
      await page.locator(`#comment-${id(3001)}`).getByRole('button', { name: 'Xóa', exact: true }).click(); await page.getByRole('dialog', { name: 'Xóa bình luận?', exact: true }).getByRole('button', { name: 'Xóa', exact: true }).click();
      await page.locator(`#comment-${id(3001)}`).waitFor({ state: 'hidden' });
      s.denied = true;
      await section.getByText('Không tải được bình luận.', { exact: false }).waitFor({ timeout: 35000 }); assert.equal(await section.locator('.comment').count(), 0);
      await shot(page, `${label}-denied`); checks.push(stage);
      stage = `${label}:local-block-cached-root`;
      s.denied = false;
      await page.goto(`${h.baseURL}${ui}?comment=${f.roots[19].id}`);
      await page.locator(`#comment-${f.roots[19].id}`).getByRole('button', { name: 'Báo cáo', exact: true }).click();
      await page.getByRole('dialog').getByRole('radio', { name: 'Spam', exact: true }).check();
      await page.getByRole('dialog').getByRole('button', { name: 'Gửi báo cáo', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Chặn / }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Chặn', exact: true }).click();
      // Mock GETs deliberately keep returning the old row. Local suppression must
      // hide it immediately, independently of successful broad invalidation.
      await until(() => section.locator('.comment').count().then(n => n === 0), 'blocked root hides replies and cached context');
      await shot(page, `${label}-blocked`); checks.push(stage);
      closing = true; await context.close(); closing = false;
    }
    assert.deepEqual(blocked, []);
    const budgets = new Map(); for (const f of faults) for (const type of ['http', 'console']) { const k = `${f.label}|${type}|${f.path}|${f.status}`; budgets.set(k, (budgets.get(k) ?? 0) + 1); }
    const unexpected = errors.filter(e => { const match = e.type === 'console' && /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(e.message); const k = `${e.label}|${e.type}|${e.path}|${e.status ?? (match ? Number(match[1]) : 0)}`; if ((budgets.get(k) ?? 0) > 0) { budgets.set(k, budgets.get(k) - 1); return false; } return true; });
    assert.deepEqual(unexpected, []); assert.deepEqual([...budgets].filter(([, n]) => n), []);
    await h.writeResult({ ok: true, mockOnly: true, checks, inventory, errors, faults, blocked, requests, limitations: ['Synthetic UI integration, not DB ACL/cost, real realtime transport or device evidence.', '403 polling models access revocation; no real block or account switching.', 'Delete mocks model empty history, not concurrent Mongo mutations.'] });
    console.log(`PASS ${checks.length} Friends comment checks; evidence: ${h.evidenceDir}`);
  } catch (e) {
    await h.screenshot(activePage, 'failure', { fullPage: false }).catch(() => {}); const failure = h.sanitize(String(e?.message ?? e));
    await h.writeResult({ ok: false, stage, failure, checks, inventory, errors, faults, blocked, requests }); console.error(`${failure}\nEvidence: ${h.evidenceDir}`); process.exitCode = 1;
  } finally { closing = true; await browser?.close(); }
}
