'use strict';
// Offline Express 4 contract tests. No listener, database, environment or provider is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { test } = require('node:test');
const ts = require('typescript');
const express = require('express');
const { z } = require('zod');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, Date, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency in ${relative}: ${name}`);
    return mocks[name];
  } }, { filename });
  return mod.exports;
}

// Exercise the real Express stack using Node's request/response objects on an in-memory socket.
function request(app, method, url, { token = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    socket.on('error', reject);
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { host: 'test', ...(token ? { authorization: 'Bearer valid' } : {}) };
    if (body !== undefined) {
      const data = Buffer.from(JSON.stringify(body));
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(data.length);
      req.push(data);
    }
    req.push(null);
    req.complete = true; // No HTTP parser exists on this in-memory socket.
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
    });
    const timer = setTimeout(() => reject(new Error(`In-memory request timed out: ${method} ${url}; complete=${req.complete}; read=${req.readableEnded}; headers=${res.headersSent}`)), 5000);
    res.on('finish', () => clearTimeout(timer));
    app.handle(req, res);
  });
}

function harness({ baseline = false, paired = true, friendsMember = true } = {}) {
  const state = { paired, version: 0, credentialReads: 0, coupleReads: 0, calls: [], order: [] };
  const errors = load('utils/errors.ts', {});
  const response = load('utils/response.ts', {});
  const errorHandler = load('middleware/errorHandler.ts', {
    zod: { ZodError: z.ZodError }, '../utils/errors.js': errors, '../utils/response.js': response,
    '../utils/logger.js': { logger: { error() {} } },
  });
  const credential = load('services/credential.service.ts', {
    bcryptjs: {}, '../repositories/user.repository.js': { userRepository: { async findCredentialsById() {
      state.credentialReads++; state.order.push('auth');
      return { _id: 'u', email: 'person@example.test', credentialVersion: state.version };
    } } }, '../utils/errors.js': errors,
  });
  const auth = load('middleware/auth.ts', {
    '../services/token.service.js': { tokenService: { verifyAccess() { return { sub: 'u', credentialVersion: 0, expiresAtMs: 9999999999999 }; } } },
    '../services/credential.service.js': credential, '../utils/errors.js': errors, './errorHandler.js': errorHandler,
  });
  const couple = load('middleware/coupleContext.ts', {
    '../repositories/user.repository.js': { userRepository: { async findById() { state.coupleReads++; state.order.push('couple'); return { coupleId: state.paired ? 'c' : null }; } } },
    '../repositories/couple.repository.js': { coupleRepository: { async findActiveById() { return { _id: 'c' }; } } },
    '../utils/errors.js': errors,
  });
  const validation = load('middleware/validate.ts', {});
  const limiter = (_req, _res, next) => { state.order.push('limiter'); next(); };
  const rateLimits = new Proxy({}, { get: () => limiter });
  const call = name => async (...args) => { state.order.push('handler'); state.calls.push({ name, args }); return { name }; };
  const shared = {
    express, zod: { z }, '../middleware/errorHandler.js': errorHandler, '../middleware/auth.js': auth,
    '../middleware/coupleContext.js': couple, '../middleware/validate.js': validation,
    '../middleware/rateLimit.js': rateLimits, '../utils/response.js': response,
  };
  const wallet = load('routes/wallet.routes.ts', { ...shared, '../services/wallet.service.js': { walletService: { getView: call('wallet'), listLedger: call('ledger'), listLedgerPage: call('ledgerPage') } } });
  const quest = load('routes/quest.routes.ts', { ...shared,
    '../services/checkin.service.js': { checkinService: { status: call('status'), checkin: call('checkin') } },
    '../services/quest.service.js': { questService: { getToday: call('today'), claim: call('claim') } },
  });
  const water = load('routes/water.routes.ts', { ...shared,
    '../services/water.service.js': { ALLOWED_IMAGE_TYPES: { 'image/jpeg': true }, MAX_MANUAL_ML: 5000, waterService: { today: call('water') } },
    '../services/proposal.service.js': { proposalService: {} }, '../services/proposalHandlers/waterGoal.handler.js': { waterGoalPayloadSchema: z.object({}) },
  });
  const finance = load('routes/finance.routes.ts', { ...shared,
    '../models/BankTransaction.js': { MAX_TXN_NOTE: 500, TXN_DIRECTIONS: ['in', 'out'] },
    '../models/AssistantThread.js': { MAX_ASSISTANT_QUESTION: 500 }, '../models/User.js': { FINANCE_VISIBILITIES: ['private', 'partner'] },
    '../services/finance.service.js': { financeService: { getConnection: call('finance') } },
    '../services/assistant.service.js': { assistantService: {} }, '../services/savings.service.js': { savingsService: {} },
  });
  const push = load('routes/push.routes.ts', { ...shared, '../models/PushSubscription.js': { PUSH_SPACES: ['couple', 'friends'] },
    '../services/push.service.js': { pushService: { config: () => ({ enabled: false }) } },
  });
  const friends = load('routes/friends.routes.ts', { ...shared,
    '../middleware/friendsContext.js': { requireFriendsMember(req, _res, next) { req.friendsMember = { id: 'u' }; next(); } },
    '../models/FriendSafety.js': { REPORT_REASONS: ['other'], REPORT_TARGETS: ['user'] }, '../models/User.js': { MAX_FRIENDS_BIO: 500 },
    '../services/friendInvite.service.js': { friendInviteService: {} }, '../services/friendNotifications.service.js': { friendNotificationsService: {} },
    '../services/friendSafety.service.js': { friendSafetyService: {} }, '../services/friendStory.service.js': { friendStoryService: {} },
    '../services/friendSuggestion.service.js': { friendSuggestionService: {} }, '../services/friends.service.js': { friendsService: { overview: call('friends') } },
  });
  const story = load('routes/story.routes.ts', { ...shared,
    '../models/Story.js': { MAX_STORY_BODY: 5000, MAX_STORY_PHOTOS: 10, MAX_STORY_VIDEOS: 2, MAX_STORY_VIDEO_BYTES: 50000000, STORY_VIDEO_MIME_TYPES: ['video/mp4'], MOODS: ['happy'], REACTION_TYPES: ['like'] },
    '../models/StoryComment.js': { MAX_COMMENT_BODY: 2000 },
    '../services/story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': true }, storyService: { listCommentsPage: call('commentsPage'), listComments: call('comments') } },
  });
  const threadShared = { ...shared,
    '../middleware/friendsContext.js': { requireFriendsMember(req, _res, next) { if (!friendsMember) return next(errors.Errors.forbidden()); req.friendsMember = { id: 'u' }; next(); } },
    '../models/StoryComment.js': { MAX_COMMENT_BODY: 2000 },
    '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 },
    '../services/story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': true } },
  };
  const threadService = { listCommentsPage: call('threadPage'), commentContext: call('threadContext'), listComments: call('threadLegacy') };
  const friendStory = load('routes/friendStory.routes.ts', { ...threadShared,
    '../models/FriendStory.js': { MAX_POLL_OPTION: 100, POLL_DURATION_DAYS: [1, 7], POLL_MAX_OPTIONS: 10, POLL_MIN_OPTIONS: 2 },
    '../models/Story.js': { MAX_STORY_BODY: 5000, MAX_STORY_PHOTOS: 10, MAX_STORY_VIDEOS: 2, MAX_STORY_VIDEO_BYTES: 50000000, STORY_VIDEO_MIME_TYPES: ['video/mp4'], REACTION_TYPES: ['like'] },
    '../services/friendStory.service.js': { friendStoryService: threadService }, '../services/friendSafety.service.js': { friendSafetyService: {} },
  });
  const friendEvent = load('routes/friendEvent.routes.ts', { ...threadShared,
    '../models/FriendEvent.js': { MAX_EVENT_DESCRIPTION: 5000, MAX_EVENT_INVITEES: 100, MAX_EVENT_MAP_URL: 2000, MAX_EVENT_PLACE: 500, MAX_EVENT_TITLE: 200, RSVP_STATUSES: ['going', 'maybe', 'declined'] },
    '../services/friendEvent.service.js': { friendEventService: threadService },
  });
  const scam = load('routes/scamGame.routes.ts', { ...shared,
    '../middleware/friendsContext.js': { requireFriendsMember(req, _res, next) { if (!friendsMember) return next(errors.Errors.forbidden()); req.friendsMember = { _id: 'u' }; next(); } },
    '../services/scamGame.service.js': { scamGameService: Object.fromEntries(['state', 'leaderboard', 'start', 'message', 'verify', 'stop'].map(name => [name, call(`scam:${name}`)])) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/friends/scam', scam.scamGameRouter);
  app.use('/api/friends/stories', friendStory.friendStoryRouter);
  app.use('/api/friends/events', friendEvent.friendEventRouter);
  app.use('/api/stories', story.storyRouter);
  // Follow createApp's mounting order. The baseline fixture models the former broad guards.
  app.use('/api/finance', finance.financeRouter);
  app.use('/api/friends', friends.friendsRouter);
  app.use('/api/push', push.pushRouter);
  if (baseline) {
    app.use('/api', express.Router().use(auth.requireAuth, couple.requireCouple));
    app.use('/api', express.Router().use(auth.requireAuth, couple.requireCouple));
  }
  app.use('/api', wallet.walletRouter);
  app.use('/api', quest.questRouter);
  app.use('/api/water', water.waterRouter);
  app.use(errorHandler.notFoundHandler, errorHandler.errorHandler);
  return { app, state, validation, errorHandler };
}

test('downstream composed router drops credential reads from three to one with unchanged envelope', async () => {
  for (const [baseline, expected] of [[true, 3], [false, 1]]) {
    const h = harness({ baseline });
    const res = await request(h.app, 'GET', '/api/water/today');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { data: { name: 'water' } });
    assert.equal(h.state.credentialReads, expected);
    assert.equal(h.state.coupleReads, 1);
  }
});

test('matched wallet and quest endpoints authenticate once, enforce pairing and preserve order', async () => {
  const cases = [
    ['GET', '/api/wallet', 200, 'wallet'], ['GET', '/api/ledger?type=coin&extra=ignored', 200, 'ledger'],
    ['GET', '/api/checkin', 200, 'status'], ['POST', '/api/checkin', 201, 'checkin'],
    ['GET', '/api/quests/today', 200, 'today'], ['POST', '/api/quests/first/claim', 200, 'claim'],
  ];
  for (const [method, url, status, name] of cases) {
    const h = harness();
    const res = await request(h.app, method, url);
    assert.equal(res.status, status, url);
    assert.deepEqual(res.body, { data: { name } });
    assert.equal(h.state.credentialReads, 1, url);
    assert.equal(h.state.coupleReads, 1, url);
    assert.deepEqual(h.state.order, name === 'checkin' ? ['auth', 'couple', 'limiter', 'handler'] : ['auth', 'couple', 'handler']);
    const anon = await request(h.app, method, url, { token: false });
    assert.equal(anon.status, 401, url);
    assert.equal(anon.body.error.code, 'UNAUTHORIZED');
    const unpaired = harness({ paired: false });
    const denied = await request(unpaired.app, method, url);
    assert.equal(denied.status, 403, url);
    assert.equal(denied.body.error.code, 'NO_COUPLE');
    assert.equal(unpaired.state.calls.length, 0);
  }
  const h = harness();
  for (const [method, url] of [['GET', '/api/ledger?type=bad'], ['POST', `/api/quests/${'x'.repeat(65)}/claim`]]) {
    const result = await request(h.app, method, url);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    assert.ok(result.body.error.details);
  }
  assert.equal(h.state.calls.length, 0);
});

test('additive history routes validate page bounds and defaults without changing legacy arrays', async () => {
  for (const [base, name] of [['/api/ledger', 'ledgerPage'], ['/api/stories/000000000000000000000001/comments', 'commentsPage']]) {
    const h = harness();
    assert.equal((await request(h.app, 'GET', `${base}/page`)).status, 200);
    assert.equal(h.state.calls[0].name, name);
    assert.equal(h.state.calls[0].args.at(-1).limit, 20);
    const max = await request(h.app, 'GET', `${base}/page?limit=50&cursor=opaque&extra=ignored`);
    assert.equal(max.status, 200);
    assert.equal(JSON.stringify(h.state.calls.at(-1).args.at(-1)), JSON.stringify({ limit: 50, cursor: 'opaque' }));
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=bad', 'cursor=', `cursor=${'a'.repeat(1025)}`]) {
      const before = h.state.calls.length;
      assert.equal((await request(h.app, 'GET', `${base}/page?${query}`)).status, 400, query);
      assert.equal(h.state.calls.length, before);
    }
    assert.equal((await request(h.app, 'GET', `${base}/page`, { token: false })).status, 401);
    assert.equal((await request(harness({ paired: false }).app, 'GET', `${base}/page`)).status, 403);
    assert.equal((await request(h.app, 'GET', base)).status, 200);
    assert.equal(h.state.calls.at(-1).name, name === 'ledgerPage' ? 'ledger' : 'comments');
  }
});

test('Friends root/reply/context routes preserve auth, membership, bounds and legacy dispatch', async () => {
  const root = '000000000000000000000002';
  for (const kind of ['stories', 'events']) {
    const base = `/api/friends/${kind}/000000000000000000000001/comments`;
    for (const suffix of ['/page', `/${root}/replies/page`, `/${root}/context`]) {
      const h = harness();
      const response = await request(h.app, 'GET', base + suffix);
      assert.equal(response.status, 200);
      const call = h.state.calls.at(-1);
      assert.equal(call.name, suffix.endsWith('context') ? 'threadContext' : 'threadPage');
      if (!suffix.endsWith('context')) assert.equal(call.args[2].limit, 20);
      if (suffix.includes('replies')) assert.equal(call.args[3], root);
      assert.equal(h.state.credentialReads, 1);
      assert.equal((await request(h.app, 'GET', base + suffix, { token: false })).status, 401);
      const denied = harness({ friendsMember: false });
      assert.equal((await request(denied.app, 'GET', base + suffix)).status, 403);
      assert.equal(denied.state.calls.length, 0);
    }
    const h = harness();
    for (const suffix of ['/page', `/${root}/replies/page`]) {
      for (const q of ['limit=0', 'limit=51', 'limit=1.5', 'limit=bad', 'cursor=', `cursor=${'a'.repeat(1025)}`])
        assert.equal((await request(h.app, 'GET', `${base}${suffix}?${q}`)).status, 400, q);
      assert.equal((await request(h.app, 'GET', `${base}${suffix}?limit=50&cursor=opaque&ignored=1`)).status, 200);
      assert.equal(JSON.stringify(h.state.calls.at(-1).args[2]), JSON.stringify({ limit: 50, cursor: 'opaque' }));
    }
    assert.equal((await request(h.app, 'GET', `${base}/bad/context`)).status, 400);
    assert.equal((await request(h.app, 'GET', base)).status, 200);
    assert.equal(h.state.calls.at(-1).name, 'threadLegacy');
  }
});

test('scam routes use authenticated owner, current Friends membership, consent and bounded validated inputs', async () => {
  const operation = { operationId: '66cb0caf-4463-4bb5-b937-08af792ad465', expectedRevision: 0, matchId: '04f1e1ba-eaa0-4332-9711-7a6cdddf8a1f' };
  for (const [method, suffix, body] of [
    ['GET', '/state'], ['GET', '/leaderboard'], ['POST', '/start', { ...operation, consent: true }],
    ['POST', '/message', { ...operation, text: '  chào  ', userId: 'forged' }],
    ['POST', '/verify', { ...operation, stage: 'otp', value: '001234' }], ['POST', '/stop', operation],
  ]) {
    const h = harness(); const url = '/api/friends/scam' + suffix;
    assert.equal((await request(h.app, method, url, { body })).status, 200);
    assert.equal(h.state.calls[0].args[0], 'u');
    assert.equal(h.state.credentialReads, 1); assert.equal(h.state.coupleReads, 0);
    if (suffix === '/message') { assert.equal(h.state.calls[0].args[2], 'chào'); assert.equal(h.state.calls[0].args[1].userId, undefined); }
    if (suffix === '/verify') assert.equal(h.state.calls[0].args[3], '001234');
    if (suffix === '/leaderboard') assert.equal(h.state.calls[0].args[1], 20);
    assert.equal((await request(h.app, method, url, { body, token: false })).status, 401);
    assert.equal((await request(harness({ friendsMember: false }).app, method, url, { body })).status, 403);
  }
  for (const [suffix, body] of [
    ['/start', operation], ['/start', { ...operation, consent: false }],
    ['/message', { ...operation, text: ' ' }], ['/message', { ...operation, text: 'x'.repeat(1201) }],
    ['/message', { ...operation, expectedRevision: -1, text: 'x' }],
    ['/verify', { ...operation, stage: 'other', value: 'x' }], ['/verify', { ...operation, stage: 'otp', value: '' }],
    ['/stop', { ...operation, operationId: 'bad' }],
  ]) { const h = harness(); assert.equal((await request(h.app, 'POST', '/api/friends/scam' + suffix, { body })).status, 400); assert.equal(h.state.calls.length, 0); }
  for (const q of ['limit=0', 'limit=51', 'limit=bad', 'cursor=']) assert.equal((await request(harness().app, 'GET', '/api/friends/scam/leaderboard?' + q)).status, 400);
});

test('revocation is checked on each request; unrelated and unknown routes are not intercepted', async () => {
  const h = harness();
  assert.equal((await request(h.app, 'GET', '/api/wallet')).status, 200);
  h.state.version = 1;
  const revoked = await request(h.app, 'GET', '/api/wallet');
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error.code, 'UNAUTHORIZED');
  assert.equal(h.state.credentialReads, 2);
  assert.equal(h.state.calls.length, 1);
  for (const url of ['/api/finance/connection', '/api/push/config', '/api/friends/']) {
    const unpaired = harness({ paired: false });
    assert.equal((await request(unpaired.app, 'GET', url)).status, 200, url);
    assert.equal(unpaired.state.credentialReads, 1, url);
    assert.equal(unpaired.state.coupleReads, 0, url);
  }
  for (const [method, url] of [['GET', '/api/nonexistent'], ['DELETE', '/api/wallet'], ['GET', '/api/quests/nope']]) {
    const unknown = harness();
    const result = await request(unknown.app, method, url, { token: false });
    assert.equal(result.status, 404, url);
    assert.deepEqual(result.body, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    assert.equal(unknown.state.credentialReads, 0);
  }
});

test('validation replaces all parsed parts atomically, strips unknowns and preserves errors', async () => {
  const h = harness();
  const app = express();
  app.use(express.json());
  let handled = 0, failureSnapshot;
  const schemas = {
    body: z.object({ nested: z.object({ value: z.string().trim() }), tags: z.array(z.string()), flag: z.boolean().default(true) }),
    query: z.object({ count: z.coerce.number().int().min(1).default(7), tags: z.array(z.string()).optional(), nested: z.object({ value: z.coerce.number() }).optional() }),
    params: z.object({ id: z.coerce.number().int().positive() }),
  };
  app.post('/inspect/:id', h.validation.validate(schemas), (req, res) => {
    handled++;
    res.json({ body: req.body, query: req.query, params: req.params });
  });
  app.use((err, req, _res, next) => { failureSnapshot = JSON.parse(JSON.stringify({ body: req.body, query: req.query, params: req.params })); next(err); });
  app.use(h.errorHandler.notFoundHandler, h.errorHandler.errorHandler);
  const good = await request(app, 'POST', '/inspect/42?count=3&tags=a&tags=b&nested[value]=12&extra=x', {
    body: { nested: { value: ' hi ', extra: true }, tags: ['a', 'b'], extra: true },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { body: { nested: { value: 'hi' }, tags: ['a', 'b'], flag: true }, query: { count: 3, tags: ['a', 'b'], nested: { value: 12 } }, params: { id: 42 } });
  const defaults = await request(app, 'POST', '/inspect/1', { body: { nested: { value: 'x' }, tags: [] } });
  assert.equal(defaults.body.query.count, 7);
  for (const [url, body] of [
    ['/inspect/1?count=bad', { nested: { value: ' x ' }, tags: [], extra: 1 }],
    ['/inspect/invalid?count=3', { nested: { value: ' x ' }, tags: [], extra: 1 }],
    ['/inspect/1', { nested: { value: 1 }, tags: [] }],
  ]) {
    const result = await request(app, 'POST', url, { body });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    assert.ok(result.body.error.details);
    assert.deepEqual(failureSnapshot.body, body, 'no parsed body is published on any failure');
    if (url.includes('count=3')) assert.equal(failureSnapshot.query.count, '3');
  }
  assert.equal(handled, 2);
});
