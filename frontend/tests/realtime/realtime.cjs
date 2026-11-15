'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
const root = path.resolve(__dirname, '../../src');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, TextDecoder, TextEncoder, DOMException, AbortController, Headers, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name} in ${relative}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const parser = load('features/realtime/parser.ts');
class TestApiError extends Error { constructor(status) { super('denied'); this.status = status; } }
const invalidation = load('features/realtime/invalidation.ts', { './parser': parser, '../../lib/apiClient': { advanceAccessEpoch() {}, ApiRequestError: TestApiError } });
const encode = new TextEncoder();
const frame = (event, payload) => `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const p = new parser.EventParser();
  const wire = encode.encode(': ♥ heartbeat\r\n\r\n' + frame('ready', { version: 1, domains: [] }) + frame('dirty', { version: 1, domains: ['friend-events', 'friend-outings'] }));
  const events = [];
  for (const byte of wire) events.push(...p.push(Uint8Array.of(byte)));
  assert.deepEqual(plain(events), [{ type: 'ready', domains: [] }, { type: 'dirty', domains: ['friend-events', 'friend-outings'] }]);
  assert.equal(new parser.EventParser().push(encode.encode(frame('dirty', { version: 1, domains: ['unknown'] }) + frame('ready', { version: 2, domains: [] }) + 'event: access\ndata: {broken}\n\n')).length, 0);
  assert.throws(() => new parser.EventParser().push(encode.encode('x'.repeat(65537))), /large/);
  assert.equal(new parser.EventParser().push(encode.encode(frame('dirty', { version: 1, domains: ['water'] }).repeat(2000))).length, 2000);
  const keys = plain(invalidation.queryPrefixes(['friend-events', 'friend-outings', 'friend-posts', 'friend-notifications']));
  for (const key of ['events', 'event', 'event-comments', 'outings', 'outing', 'feed', 'story', 'comments', 'user-stories', 'poll-voters', 'notifications', 'unread']) assert.ok(keys.some(k => k[0] === 'friends' && k[1] === key), key);
  assert.deepEqual(plain(invalidation.queryPrefixes(['friend-events', 'friends'])), [['friends']]);
  assert.ok(invalidation.needsMe(invalidation.scopeDomains('couple')));
  const calls = [];
  const qc = { cancelQueries: x => { calls.push(['cancel', x.queryKey]); }, resetQueries: x => { calls.push(['reset', x.queryKey]); }, invalidateQueries: x => { calls.push(['invalidate', x.queryKey]); } };
  invalidation.revokeDomains(qc, 'friends', ['friends']);
  assert.deepEqual(plain(calls), [['cancel', ['friends']], ['reset', ['friends']]]);
  const { QueryClient, QueryObserver } = require('@tanstack/query-core');
  const realCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let resolveOld;
  realCache.setQueryData(['friends', 'outing', '1'], { secret: 'old' });
  const oldFetch = realCache.fetchQuery({ queryKey: ['friends', 'outing', '1'], queryFn: () => new Promise(resolve => { resolveOld = resolve; }) }).catch(() => undefined);
  invalidation.revokeDomains(realCache, 'friends', ['friends']);
  assert.equal(realCache.getQueryData(['friends', 'outing', '1']), undefined, 'revocation clears warm cache synchronously');
  resolveOld({ secret: 'late' }); await oldFetch;
  assert.equal(realCache.getQueryData(['friends', 'outing', '1']), undefined, 'cancelled GET cannot repopulate');
  await realCache.fetchQuery({ queryKey: ['friends', 'outing', '1'], queryFn: async () => ({ access: 'restricted', balance: 17 }) });
  assert.deepEqual(realCache.getQueryData(['friends', 'outing', '1']), { access: 'restricted', balance: 17 });
  // A seen acknowledgement must synchronize badges across tabs without refetching
  // the feed, whose dataUpdatedAt effect would issue another seen acknowledgement.
  assert.deepEqual(plain(new parser.EventParser().push(encode.encode(frame('dirty', { version: 1, domains: ['story-unread'] })))), [{ type: 'dirty', domains: ['story-unread'] }]);
  assert.deepEqual(plain(invalidation.queryPrefixes(['story-unread'])), [['stories', 'unread']]);
  assert.ok(invalidation.scopeDomains('couple').includes('story-unread'));
  const seenClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const seenReads = { feed: 0, unread: 0, otd: 0 };
  const seenObservers = [
    ['feed', ['stories', 'feed']], ['unread', ['stories', 'unread']], ['otd', ['stories', 'on-this-day']],
  ].map(([name, queryKey]) => new QueryObserver(seenClient, {
    queryKey, queryFn: async () => { seenReads[name]++; return { name }; },
  }));
  const seenUnsubscribe = seenObservers.map(observer => observer.subscribe(() => {}));
  await tick();
  for (let n = 0; n < 3; n++) { invalidation.invalidateDomains(seenClient, ['story-unread'], 'couple'); await tick(); }
  assert.deepEqual(seenReads, { feed: 1, unread: 4, otd: 1 });
  for (const unsubscribe of seenUnsubscribe) unsubscribe();
  seenClient.clear();
  const verifyClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  verifyClient.setQueryData(['friends', 'event', 'inactive'], { secret: 'old' });
  verifyClient.setQueryData(['friends', 'outing', 'active'], { secret: 'old' });
  let mode = 'ok';
  const observer = new QueryObserver(verifyClient, { queryKey: ['friends', 'outing', 'active'], staleTime: Infinity, queryFn: async () => {
    if (mode === 'denied') throw new TestApiError(403);
    if (mode === 'offline') throw new Error('offline');
    return { access: 'restricted', balance: 17 };
  } });
  const unsubscribe = observer.subscribe(() => {});
  assert.equal(await invalidation.verifyScope(verifyClient, 'friends', () => true), true);
  assert.deepEqual(verifyClient.getQueryData(['friends', 'outing', 'active']), { access: 'restricted', balance: 17 });
  assert.equal(verifyClient.getQueryData(['friends', 'event', 'inactive']), undefined);
  mode = 'offline'; assert.equal(await invalidation.verifyScope(verifyClient, 'friends', () => true), false);
  mode = 'denied'; assert.equal(await invalidation.verifyScope(verifyClient, 'friends', () => true), true);
  assert.equal(verifyClient.getQueryData(['friends', 'outing', 'active']), undefined);
  assert.equal(observer.getCurrentResult().error.status, 403);
  unsubscribe();
  // Exercise document-level masking including portal roots, without a browser renderer.
  class Element {
    constructor(tag = 'DIV') { this.tagName = tag; this.attrs = new Map(); this.inert = false; this.isConnected = true; this.values = new Map(); this.style = {
      getPropertyValue: key => this.values.get(key)?.[0] ?? '', getPropertyPriority: key => this.values.get(key)?.[1] ?? '',
      setProperty: (key, value, priority = '') => this.values.set(key, [value, priority]), removeProperty: key => this.values.delete(key),
    }; }
    setAttribute(key, value) { this.attrs.set(key, value); } getAttribute(key) { return this.attrs.get(key) ?? null; } removeAttribute(key) { this.attrs.delete(key); }
    blur() {} remove() { this.isConnected = false; }
  }
  let observerCallback; const root = new Element(); const portal = new Element(); portal.setAttribute('aria-hidden', 'false');
  const body = { children: [root, portal], appendChild: node => body.children.push(node) };
  const pauseCalls = [];
  const verification = load('features/realtime/verification.tsx', { react: {}, 'react/jsx-runtime': {}, 'react-dom': {}, '../../hooks/useModal': { setModalPrivacyPause: value => pauseCalls.push(value) } }, {
    HTMLElement: Element, document: { body, activeElement: null, createElement: tag => new Element(tag.toUpperCase()) },
    MutationObserver: class { constructor(cb) { observerCallback = cb; } observe() {} disconnect() {} },
  });
  verification.setVerification('checking');
  assert.equal(root.style.getPropertyValue('display'), 'none'); assert.equal(portal.inert, true); assert.equal(portal.getAttribute('aria-hidden'), 'true');
  const newPortal = new Element(); body.children.push(newPortal); observerCallback(); assert.equal(newPortal.style.getPropertyValue('display'), 'none');
  verification.setVerification('clear');
  assert.equal(root.style.getPropertyValue('display'), ''); assert.equal(portal.inert, false); assert.equal(portal.getAttribute('aria-hidden'), 'false');
  assert.deepEqual(pauseCalls, [true, false]);
  const batches = [];
  const batch = new invalidation.DomainBatch(domains => batches.push(plain(domains)), 5);
  batch.add(['stories']); batch.add(['stories', 'wallet']);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(batches, [['stories', 'wallet']]);
  batch.add(['water']); batch.clear(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(batches.length, 1);

  let generation = 'a'; let tokens = { accessToken: 'old', refreshToken: 'refresh' }; let releaseRefresh; let refreshCalls = 0; let requests = [];
  const tokenStore = { generation: () => generation, isCurrent: x => x === generation, get: () => tokens,
    rotate: (value, g) => { if (g !== generation) return false; tokens = value; return true; }, clear: () => false };
  const fetch = async (url, init) => {
    if (url.endsWith('/auth/refresh')) { refreshCalls++; return new Promise(resolve => { releaseRefresh = () => resolve(new Response(JSON.stringify({ data: { accessToken: 'new', refreshToken: 'r2' } }), { status: 200 })); }); }
    requests.push({ url, authorization: init.headers.get('Authorization') });
    return init.headers.get('Authorization') === 'Bearer old' ? new Response('{"error":{"code":"OLD","message":"old"}}', { status: 401 }) : new Response('{"data":{"ok":true}}', { status: 200 });
  };
  const api = load('lib/apiClient.ts', { './tokenStore': { tokenStore } }, { fetch, window: { dispatchEvent() {} } });
  const controller = new AbortController();
  const streamRequest = api.authenticatedResponse('/realtime?space=friends', { signal: controller.signal }).catch(e => e.name);
  const rest = api.apiRequest('/me');
  await tick(); assert.equal(refreshCalls, 1); controller.abort(); releaseRefresh();
  assert.equal(await streamRequest, 'AbortError'); assert.deepEqual(plain(await rest), { ok: true });
  assert.equal(requests.filter(x => x.authorization === 'Bearer new').length, 1);
  generation = 'b'; tokens = { accessToken: 'old', refreshToken: 'refresh' }; requests = [];
  const stale = api.apiRequest('/me').catch(e => e.code); await tick(); generation = 'c'; releaseRefresh();
  assert.equal(await stale, 'SESSION_CHANGED'); assert.equal(requests.length, 1);
  let resolveLate;
  const privacyApi = load('lib/apiClient.ts', { './tokenStore': { tokenStore } }, { fetch: () => new Promise(resolve => { resolveLate = resolve; }), window: { dispatchEvent() {} } });
  for (const method of ['GET', 'POST']) {
    const pending = privacyApi.apiRequest('/friends/outing', { method, body: method === 'POST' ? { operationId: 'fixed-key' } : undefined }).catch(e => e);
    privacyApi.advanceAccessEpoch();
    resolveLate(new Response('{"data":{"private":true}}', { status: 200 }));
    const error = await pending;
    assert.equal(error.code, 'ACCESS_CHANGED'); assert.equal(error.status, 503);
  }
  const failedApi = load('lib/apiClient.ts', { './tokenStore': { tokenStore } }, { window: { dispatchEvent() {} }, fetch: async url => url.endsWith('/auth/refresh') ? new Response('', { status: 503 }) : new Response('{"error":{"code":"ORIGINAL","message":"original failure"}}', { status: 401 }) });
  await assert.rejects(failedApi.apiRequest('/me'), e => e.status === 401 && e.code === 'ORIGINAL' && e.message === 'original failure');

  let releaseAccessRefresh; let accessRequests = 0;
  const duringRefresh = load('lib/apiClient.ts', { './tokenStore': { tokenStore } }, { window: { dispatchEvent() {} }, fetch: async url => {
    if (url.endsWith('/auth/refresh')) return new Promise(resolve => { releaseAccessRefresh = resolve; });
    accessRequests++; return new Response('{}', { status: 401 });
  } });
  const pendingRefreshMutation = duringRefresh.apiRequest('/friends/outing', { method: 'POST', body: { operationId: 'original' } }).catch(e => e);
  await tick(); duringRefresh.advanceAccessEpoch();
  releaseAccessRefresh(new Response(JSON.stringify({ data: { accessToken: 'rotated', refreshToken: 'r2' } }), { status: 200 }));
  assert.equal((await pendingRefreshMutation).code, 'ACCESS_CHANGED');
  assert.equal(accessRequests, 1, 'never retry a mutation after access epoch changes');

  const stream = load('features/realtime/stream.ts', { '../../lib/apiClient': api, './parser': parser });
  assert.equal(stream.reconnectDelay(0, 0), 500); assert.equal(stream.reconnectDelay(50, 1), 30000);
  assert.equal(stream.retryAfter('2'), 2000); assert.equal(stream.retryAfter('9999'), 120000);
  let deliver; let received = []; let stoppedDisconnects = 0;
  const mocked = load('features/realtime/stream.ts', { '../../lib/apiClient': { authenticatedResponse: () => new Promise(resolve => { deliver = resolve; }) }, './parser': parser });
  const instance = new mocked.RealtimeStream('friends', event => received.push(event), () => stoppedDisconnects++);
  instance.start(); instance.stop();
  deliver(new Response(frame('ready', { version: 1, domains: [] }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await tick(); assert.equal(received.length, 0); assert.equal(stoppedDisconnects, 0);
  let disconnects = 0;
  const eofStream = load('features/realtime/stream.ts', { '../../lib/apiClient': { authenticatedResponse: async () => new Response('', { headers: { 'Content-Type': 'text/event-stream' } }) }, './parser': parser });
  const eof = new eofStream.RealtimeStream('friends', () => {}, () => { disconnects++; });
  eof.start(); await tick(); assert.equal(disconnects, 1); eof.stop();

  const listeners = new Map(); let eligible = true; const transitions = [];
  const react = {
    useState: () => [eligible, value => { transitions.push(['eligible', value]); eligible = value; }],
    useLayoutEffect: effect => { effect(); },
  };
  const fakeDoc = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} };
  const fakeWindow = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} };
  const sync = load('features/realtime/RealtimeSync.tsx', {
    react, '@tanstack/react-query': { useQueryClient: () => ({}) },
    '../auth/AuthContext': { useAuth: () => ({ isAuthenticated: true, me: { user: { id: 'a' } }, space: 'friends', refreshMe() {}, revokeMe() {}, verifyMe() {} }) },
    '../../lib/tokenStore': { tokenStore: { generation: () => 'a', isCurrent: () => true, get: () => ({}) } },
    '../../lib/apiClient': { advanceAccessEpoch() {} }, './invalidation': { ...invalidation, verifyScope: async () => true },
    './verification': { setVerification: status => transitions.push(['mask', status]) },
    './stream': { RealtimeStream: class { start() {} stop() {} } },
  }, { document: fakeDoc, window: fakeWindow, navigator: { onLine: true } });
  sync.RealtimeSync(); transitions.length = 0;
  fakeDoc.visibilityState = 'hidden'; listeners.get('visibilitychange')();
  assert.deepEqual(transitions.slice(0, 2), [['mask', 'checking'], ['eligible', false]], 'mask must precede state update');
  console.log('PASS realtime parser, mapping, batching, refresh sharing, session guard and stopped stream');
})().catch(error => { console.error(error); process.exitCode = 1; });
