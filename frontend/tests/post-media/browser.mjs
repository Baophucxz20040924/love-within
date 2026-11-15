// Run sequentially against operator-owned localhost UI5175/API4002 with mock providers + memory storage.
// No server/process management, dotenv, installed app dependency, saved credentials/state, trace or HAR.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const home = process.env.LW_PW_HOME || path.join(os.tmpdir(), 'lw_pw');
const { chromium } = createRequire(path.join(home, 'package.json'))('playwright-core');
const api = 'http://127.0.0.1:4002/api';
const ui = 'http://127.0.0.1:5175';
const evidence = path.join(home, 'shots', `post-media-${Date.now()}`);
const run = randomBytes(5).toString('hex');
const checks = [], errors = [], expectedOffline = [], contexts = [];
const offlineContexts = new Set();
let browser, activePage, fixture;
await mkdir(evidence, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const routePath = url => { try { return new URL(url).pathname.replace(/[a-f\d]{24}/g, '[id]'); } catch { return '[resource]'; } };
function sanitize(text) {
  return String(text).split('\nCall log:')[0]
    .replace(/https?:\/\/[^\s)\]"']+/g, url => { try { const parsed = new URL(url); return parsed.origin + routePath(url); } catch { return '[url]'; } })
    .replace(/blob:[^\s)\]"']+/g, '[blob]').replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+/g, '[synthetic email]');
}
async function request(user, method, route, body) {
  // Only account/relationship setup may mutate through API. Posts and uploads must use actual UI.
  assert.ok(method === 'GET' || route === '/auth/register' || route === '/friends/join' || route === '/friends/requests'
    || /^\/friends\/requests\/[a-f\d]+\/accept$/.test(route) || route === '/pairing/invite' || /^\/pairing\/invites\/[a-f\d]+\/accept$/.test(route));
  await delay(900);
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${method} ${routePath(api + route)} returned ${response.status}`);
  return (await response.json()).data;
}
async function account(suffix) {
  const email = `media-${run}-${suffix}@example.test`, password = randomBytes(18).toString('hex');
  const auth = await request(null, 'POST', '/auth/register', { email, password, displayName: `Media ${suffix}` });
  const user = { email, password, token: auth.accessToken, name: `Media ${suffix}` };
  await request(user, 'POST', '/friends/join', {});
  user.id = (await request(user, 'GET', '/me')).user.id;
  return user;
}
async function session(user, space) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__mediaSseReady = 0;
    window.__mediaObjectUrls = new Set();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__mediaObjectUrls.add(url); return url; };
    URL.revokeObjectURL = url => { window.__mediaObjectUrls.delete(url); revoke(url); };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (!String(args[0]).includes('/realtime?') || !response.ok || !response.body) return response;
      const decoder = new TextDecoder(); let pending = '';
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          if (/^event:\s*ready\s*$/m.test(pending.slice(0, end))) window.__mediaSseReady++;
          pending = pending.slice(end + 2);
        }
        controller.enqueue(chunk);
      } })), { status: response.status, headers: response.headers });
    };
    // Live-post checks cannot accidentally pass because of the app's routine polling intervals.
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, [20_000, 30_000, 60_000].includes(ms) ? 3_600_000 : ms, ...args);
  });
  const page = await context.newPage(); activePage = page;
  const item = { ...user, page, context, space, requestCounts: { feed: 0, seen: 0 } };
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/stories' && request.method() === 'GET') item.requestCounts.feed++;
    if (pathname === '/api/stories/seen' && request.method() === 'POST') item.requestCounts.seen++;
  });
  page.on('pageerror', error => errors.push({ type: 'page', name: error.name, message: sanitize(error.message) }));
  page.on('response', response => {
    if (response.status() >= 400) errors.push({ type: 'http', status: response.status(), path: routePath(response.url()) });
  });
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText || 'request failed';
    // Explicit offline simulation and caller cancellation of SSE/media/navigation are not HTTP success claims.
    if (offlineContexts.has(context) || /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) {
      expectedOffline.push({ path: routePath(request.url()), reason: offlineContexts.has(context) ? 'offline simulation' : sanitize(failure) });
    } else errors.push({ type: 'request', path: routePath(request.url()), message: sanitize(failure) });
  });
  await page.goto(ui + '/login');
  if (space === 'friends') {
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Trái tim', exact: true }).click();
    await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('button', { name: 'Lên thuyền', exact: true }).click();
    await page.waitForURL('**/friends/login');
  }
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(user.password);
  await page.locator('form').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => url.pathname === (space === 'friends' ? '/friends' : '/'), { timeout: 20_000 });
  await page.waitForFunction(() => window.__mediaSseReady > 0, null, { timeout: 15_000 });
  if (space === 'couple') await delay(61_000); // Home mounts many independently authorized reads before entering Story.
  return item;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); await delay(1800); }
async function shot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled',
    mask: [page.locator('input[type=email],input[type=password]')] });
}
const dialog = page => page.getByRole('dialog', { name: 'Tạo bài viết', exact: true });
const submit = page => dialog(page).getByRole('button', { name: 'Đăng', exact: true });
const feed = space => space === 'friends' ? '/friends' : '/stories';
const postRoute = (space, id) => space === 'friends' ? `/friends/posts/${id}` : `/stories/${id}`;
const postsApi = space => space === 'friends' ? '/friends/stories' : '/stories';
const card = (page, marker) => page.locator('article.post').filter({ hasText: marker });
async function decodeImages(locator, expected) {
  await locator.first().waitFor();
  await locator.first().scrollIntoViewIfNeeded();
  await locator.evaluateAll(async (images, count) => {
    if (images.length !== count) throw new Error(`Expected ${count} images, got ${images.length}`);
    await Promise.all(images.map(image => image.decode()));
    if (images.some(image => !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0)) throw new Error('Image pixels did not decode');
  }, expected);
}
async function playPause(locator) {
  await locator.waitFor(); await locator.scrollIntoViewIfNeeded();
  // Let the IntersectionObserver settle after scrolling before beginning playback.
  await locator.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dimensions = await locator.evaluate(async video => {
    if (!video.controls || !video.playsInline || video.autoplay) throw new Error('Video controls/inline/autoplay contract');
    video.muted = true;
    video.currentTime = 0;
    await video.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { video.removeEventListener('timeupdate', progress); reject(new Error('No decoded playback progress')); }, 8000);
      const progress = () => { if (video.currentTime > 0.1 && video.readyState >= 2) { clearTimeout(timer); video.removeEventListener('timeupdate', progress); resolve(); } };
      video.addEventListener('timeupdate', progress); progress();
    });
    const dimensions = { width: video.videoWidth, height: video.videoHeight };
    video.pause();
    if (!video.paused) throw new Error('Video did not pause');
    return dimensions;
  });
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
}
async function choose(page, button, files) {
  const pending = page.waitForEvent('filechooser'); await button.click();
  await (await pending).setFiles(files);
}
async function injectFiles(page, files) {
  // setInputFiles may infer MIME. Construct real File/DataTransfer to preserve deliberately missing types.
  return dialog(page).locator('input[type=file]').evaluate((input, files) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.base64), x => x.charCodeAt(0))], file.name, { type: file.type }));
    const actual = Array.from(transfer.files, file => file.type);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return actual;
  }, files);
}
async function makeFixture(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#376a83'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#f4ca57'; ctx.fillRect(35, 35, 60, 60);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('Installed browser cannot encode the real WebM fixture');
    document.body.append(canvas);
    const stream = canvas.captureStream(12), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 180_000 });
    const result = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('Fixture encoder failed'));
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const data = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
        resolve({ png, webm: btoa(binary), videoBytes: blob.size });
      };
    });
    recorder.start();
    try {
      for (let frame = 0; frame < 30; frame++) {
        ctx.fillStyle = '#376a83'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#f4ca57'; ctx.fillRect(10 + frame * 7, 50, 50, 50);
        stream.getVideoTracks()[0].requestFrame?.();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      recorder.stop(); return await result;
    } finally { for (const track of stream.getTracks()) track.stop(); canvas.remove(); }
  });
}
async function privacyPauseAndRestore(item, video, body) {
  const { page, context } = item;
  await video.scrollIntoViewIfNeeded();
  await video.evaluate(async node => { node.muted = true; node.loop = true; node.currentTime = 0; await node.play(); });
  assert.equal(await video.evaluate(node => node.paused), false);
  const mountedVideo = await video.elementHandle();
  offlineContexts.add(context);
  try {
    await context.setOffline(true);
    // Exercise the application's real offline => privacy-mask path, not CSS hiding or directly invoking a store.
    await page.getByText('Đang kiểm tra lại quyền truy cập…', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'offline test isolates privacy mask from hidden-tab pause');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).every(video => video.paused));
    assert.equal(await mountedVideo.evaluate(node => node.isConnected), true, 'masked player remains mounted');
  } finally { await context.setOffline(false); }
  await page.getByText('Đang kiểm tra lại quyền truy cập…', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
  await delay(1500); offlineContexts.delete(context);
  assert.equal(await dialog(page).getByLabel('Nội dung bài viết', { exact: true }).inputValue(), body);
  await decodeImages(dialog(page).locator('img[alt="Ảnh đính kèm bài viết"]'), 3);
  assert.equal(await video.evaluate(node => node.paused), true, 'revalidation must not restart audio');
  await video.evaluate(node => { node.loop = false; });
}
async function rangeCheck(context, src) {
  const url = new URL(src, ui);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname), 'memory-storage fixture must stay on loopback');
  const response = await context.request.get(url.href, { headers: { Range: 'bytes=0-31' } });
  assert.equal(response.status(), 206);
  assert.match(response.headers()['content-range'], /^bytes 0-31\/\d+$/);
  assert.equal((await response.body()).length, 32);
  assert.equal(response.headers()['content-type'].split(';')[0], 'video/webm');
  // Tiny real range read, not an invented media header or a whole 50 MiB buffer.
}
async function flow(author, reader, space) {
  const a = await session(author, space), b = await session(reader, space);
  const page = a.page; activePage = page;
  const marker = `Media ${space} ${run}\nẢnh và video cùng bài`;
  let post;
  try {
    await page.goto(ui + feed(space)); await b.page.goto(ui + feed(space));
    await page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }).waitFor();
    await b.page.waitForFunction(() => window.__mediaSseReady > 0);
    await page.bringToFront();
    fixture ??= await makeFixture(page);
    assert.ok(fixture.videoBytes > 100, 'genuinely encoded fixture must contain media frames');
    await check(`${space}: feed picker initialFiles PNG preview decodes in StrictMode dev UI`, async () => {
      assert.equal(await page.locator('script[type=module][src*="/src/main"]').count(), 1, 'must verify the dev entry, not an unverified production bundle');
      const main = await page.request.get(ui + '/src/main.tsx');
      assert.ok(main.ok()); assert.match(await main.text(), /StrictMode/);
      await choose(page, page.getByRole('button', { name: 'Đăng ảnh hoặc video', exact: true }),
        { name: 'feed.png', mimeType: 'image/png', buffer: Buffer.from(fixture.png, 'base64') });
      await dialog(page).waitFor();
      await decodeImages(dialog(page).locator('img[alt="Ảnh đính kèm bài viết"]'), 1);
      await dialog(page).getByLabel('Nội dung bài viết', { exact: true }).fill(marker);
      await shot(page, `${space}-initial-png-preview`);
    });
    await check(`${space}: missing/octet MIME images decode; corrupt file stays visible and removable`, async () => {
      const actualTypes = await injectFiles(page, [
        { name: 'unknown-mime.png', type: '', base64: fixture.png },
        { name: 'octet.png', type: 'application/octet-stream', base64: fixture.png },
      ]);
      assert.deepEqual(actualTypes, ['', 'application/octet-stream']);
      await page.waitForFunction(() => document.querySelectorAll('img[alt="Ảnh đính kèm bài viết"]').length === 3);
      await decodeImages(dialog(page).locator('img[alt="Ảnh đính kèm bài viết"]'), 3);
      await injectFiles(page, [{ name: 'broken.png', type: 'image/png', base64: Buffer.from('not pixels').toString('base64') }]);
      const error = dialog(page).getByRole('alert').filter({ hasText: 'broken.png' });
      await error.waitFor(); assert.match(await error.textContent(), /JPEG\/PNG/);
      assert.equal(await submit(page).isDisabled(), true);
      await shot(page, `${space}-corrupt-file-feedback`);
      await dialog(page).locator('.composer__photo').filter({ hasText: 'broken.png' }).getByRole('button', { name: 'Bỏ ảnh này', exact: true }).click();
      await error.waitFor({ state: 'hidden' });
      // The same File can be reselected after removal, including input-reset behavior.
      await injectFiles(page, [{ name: 'broken.png', type: 'image/png', base64: Buffer.from('not pixels').toString('base64') }]);
      await error.waitFor();
      await dialog(page).locator('.composer__photo').filter({ hasText: 'broken.png' }).getByRole('button', { name: 'Bỏ ảnh này', exact: true }).click();
    });
    await check(`${space}: real encoded WebM preview decodes, plays/pauses; second video errors`, async () => {
      const input = { name: 'real-frames.webm', mimeType: 'video/webm', buffer: Buffer.from(fixture.webm, 'base64') };
      await choose(page, dialog(page).getByRole('button', { name: 'Thêm ảnh hoặc video', exact: true }).last(), input);
      await playPause(dialog(page).getByLabel('Xem trước video', { exact: true }));
      await choose(page, dialog(page).getByRole('button', { name: 'Thêm ảnh hoặc video', exact: true }).last(), { ...input, name: 'second.webm' });
      const error = dialog(page).getByRole('alert').filter({ hasText: 'second.webm' }); await error.waitFor();
      assert.match(await error.textContent(), /1 video/); assert.equal(await submit(page).isDisabled(), true);
      await dialog(page).locator('.composer__photo').filter({ hasText: 'second.webm' }).getByRole('button', { name: 'Bỏ video này', exact: true }).click();
      await shot(page, `${space}-mixed-video-preview`);
    });
    await check(`${space}: offline privacy mask pauses mounted preview and restores intact draft`, async () => {
      await privacyPauseAndRestore(a, dialog(page).getByLabel('Xem trước video', { exact: true }), marker);
      await shot(page, `${space}-draft-after-revalidation`);
    });
    await check(`${space}: UI uploads/posts mixed media and recipient sees decoded media live`, async () => {
      // Isolate publication from the read burst caused by deliberate reconnect/revalidation.
      await delay(61_000);
      await submit(page).click(); await dialog(page).waitFor({ state: 'hidden', timeout: 45_000 });
      await card(page, `Media ${space} ${run}`).waitFor();
      await card(b.page, `Media ${space} ${run}`).waitFor({ timeout: 10_000 });
      const response = await request(author, 'GET', postsApi(space));
      post = (Array.isArray(response) ? response : response.items).find(row => row.body === marker);
      assert.ok(post); assert.equal(post.photos.length, 3); assert.equal(post.videos.length, 1);
      assert.equal(post.videos[0].mimeType, 'video/webm'); assert.ok(post.videos[0].width > 0 && post.videos[0].height > 0);
      await decodeImages(card(page, `Media ${space} ${run}`).locator('.pgrid img'), 3);
      await playPause(card(page, `Media ${space} ${run}`).getByLabel('Video bài viết', { exact: true }));
      activePage = b.page;
      await decodeImages(card(b.page, `Media ${space} ${run}`).locator('.pgrid img'), 3);
      await playPause(card(b.page, `Media ${space} ${run}`).getByLabel('Video bài viết', { exact: true }));
      await shot(b.page, `${space}-recipient-live`);
      await page.waitForFunction(() => window.__mediaObjectUrls.size === 0);
    });
    await check(`${space}: reload/detail media decode and memory-storage HTTP Range`, async () => {
      if (space === 'couple') {
        await delay(2500); // Allow the mutation-driven refresh to settle before the idle observation.
        const before = { ...b.requestCounts };
        await delay(5000);
        assert.equal(b.requestCounts.feed, before.feed, 'mark-seen SSE must not keep refreshing the idle feed');
        assert.equal(b.requestCounts.seen, before.seen, 'mark-seen SSE must not acknowledge itself repeatedly');
      }
      await delay(61_000); // Separate mutation-driven refetches from reload/reconnect bursts.
      await b.page.reload(); await card(b.page, `Media ${space} ${run}`).waitFor();
      await decodeImages(card(b.page, `Media ${space} ${run}`).locator('.pgrid img'), 3);
      await playPause(card(b.page, `Media ${space} ${run}`).getByLabel('Video bài viết', { exact: true }));
      await b.page.goto(ui + postRoute(space, post.id));
      await playPause(b.page.getByLabel('Video bài viết', { exact: true }));
      await decodeImages(b.page.locator('.pgrid img'), 3);
      const src = await b.page.getByLabel('Video bài viết', { exact: true }).getAttribute('src');
      assert.ok(src); await rangeCheck(b.context, src);
      await shot(b.page, `${space}-detail-reloaded-video`);
    });
  } catch (error) {
    await activePage?.screenshot({ path: path.join(evidence, `${space}-failure.png`), fullPage: true,
      mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
    throw error;
  } finally {
    offlineContexts.delete(a.context); offlineContexts.delete(b.context);
    await a.context.close(); await b.context.close(); activePage = undefined;
  }
}

try {
  const a = await account('A'), b = await account('B');
  const friendship = await request(a, 'POST', '/friends/requests', { userId: b.id });
  await request(b, 'POST', `/friends/requests/${friendship.requestId}/accept`, {});
  const invitation = await request(a, 'POST', '/pairing/invite', { toEmail: b.email });
  await request(b, 'POST', `/pairing/invites/${invitation.id}/accept`, {});
  browser = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe'), headless: process.env.LW_HEADED !== '1', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const encoder = await browser.newPage();
  fixture = await makeFixture(encoder);
  await encoder.evaluate(async base64 => {
    const blob = new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type: 'video/webm' });
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob); video.muted = true;
    try {
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Encoded fixture failed native decode')); video.load(); });
      if (video.videoWidth !== 320 || video.videoHeight !== 180) throw new Error('Encoded fixture dimensions are invalid');
    } finally { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
  }, fixture.webm);
  await encoder.close();
  await flow(a, b, 'friends');
  await delay(61_000); // Keep real API budgets intact between separate space/UI sessions.
  await flow(a, b, 'couple');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, errors, expectedOffline,
    fixture: { container: 'WebM', source: 'browser MediaRecorder canvas animation', bytes: fixture.videoBytes },
    scope: 'Local mock/memory storage, dev StrictMode and mobile emulation only. Real browser-encoded WebM; not MP4 codec, physical phone, production S3/CORS/CSP, or audible-audio proof. Synthetic accounts/posts retained locally.' }, null, 2));
  console.log('Evidence:', evidence);
} catch (error) {
  await activePage?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true,
    mask: [activePage.locator('input[type=email],input[type=password]')] }).catch(() => {});
  const failure = sanitize(error?.message || 'Failure');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ ok: false, checks, errors, expectedOffline, failure }, null, 2));
  console.error(failure); console.log('Evidence:', evidence); process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
