'use strict';
// Exercise the real service and route with isolated repository and middleware stubs; no database or server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Types } = require('mongoose');
const { z } = require('zod');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name];
  } }, { filename });
  return mod.exports;
}
const oid = (n) => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const author = oid(1), viewer = oid(2), storyId = oid(999);
let story, friends, authorBlocked, blocked, rows, calls;
function reset() {
  story = { _id: storyId, authorId: author, hiddenByReportsAt: null, reactions: new Map() };
  friends = true; authorBlocked = false; blocked = new Set(); rows = new Map(); calls = [];
}
const userRepository = { findProfiles: async (ids) => {
  calls.push(['profiles', ids.map(String)]);
  return new Map(ids.filter((id) => rows.has(String(id))).map((id) => [String(id), rows.get(String(id))]));
} };
const profile = load('services/profile.service.ts', {
  '../integrations/index.js': { getStorage: () => ({ getDownloadUrl: async (key) => ({ url: `signed:${key}` }) }) },
  '../repositories/user.repository.js': { userRepository },
});
const service = load('services/friendStory.service.ts', {
  'node:crypto': {}, mongoose: { Types }, '../config/env.js': {}, '../models/FriendStoryComment.js': {},
  '../models/Story.js': {}, './storyMedia.service.js': {}, './mentionSpans.js': load('services/mentionSpans.ts', {
    mongoose: { Types }, '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 }, '../utils/errors.js': { AppError: Error },
  }), '../integrations/index.js': {},
  '../repositories/friendship.repository.js': { friendshipRepository: { areFriends: async () => { calls.push(['friends']); return friends; } } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: {
    isBlockedBetween: async () => { calls.push(['author-block']); return authorBlocked; },
    blockedIdsFor: async () => { calls.push(['blocked']); return blocked; },
  }, friendHiddenStoryRepository: {} },
  '../repositories/friendStory.repository.js': { friendStoryRepository: { findById: async () => { calls.push(['story']); return story; } }, friendStoryCommentRepository: {} },
  '../repositories/user.repository.js': { userRepository }, '../utils/date.js': {},
  '../utils/errors.js': { Errors: { notFound: () => Object.assign(Error('not found'), { status: 404 }) } },
  '../utils/logger.js': {}, './notification.service.js': {}, './realtimeAudience.service.js': {},
  './friends.service.js': {}, './profile.service.js': profile, './friendPoll.js': {}, './story.service.js': {},
}).friendStoryService;
const me = { _id: viewer };
const add = (n, type = 'love', exists = true) => {
  const id = String(oid(n)); story.reactions.set(id, type);
  if (exists) rows.set(id, { displayName: `Name ${n}`, avatarKey: `avatar-${n}`, email: 'private@example.test', secret: 'hidden' });
  return id;
};

async function routeTests() {
  const handlers = {};
  const router = {
    use(...fns) { this.guards = fns; },
    get(p, ...fns) { handlers[`GET ${p}`] = fns; },
    post() {}, put() {}, patch() {}, delete() {},
  };
  const pass = (_req, _res, next) => next();
  const auth = (req, _res, next) => req.auth ? next() : next(Object.assign(Error('unauthenticated'), { status: 401 }));
  const member = (req, _res, next) => req.friendsMember ? next() : next(Object.assign(Error('not member'), { status: 403 }));
  const validate = (schemas) => (req, _res, next) => {
    try { if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
      if (schemas.query) Object.assign(req.query, schemas.query.parse(req.query)); next(); } catch (e) { next(e); }
  };
  let received;
  load('routes/friendStory.routes.ts', {
    express: { Router: () => router }, zod: { z },
    '../middleware/rateLimit.js': { expensiveReadLimiter: pass },
    '../middleware/errorHandler.js': { asyncHandler: (fn) => fn },
    '../middleware/auth.js': { requireAuth: auth }, '../middleware/friendsContext.js': { requireFriendsMember: member },
    '../middleware/validate.js': { validate },
    '../models/FriendStory.js': { POLL_DURATION_DAYS: [], POLL_MAX_OPTIONS: 10, POLL_MIN_OPTIONS: 2 },
    '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 },
    '../models/Story.js': { MAX_STORY_BODY: 5000, MAX_STORY_PHOTOS: 10, MAX_STORY_VIDEOS: 1, MAX_STORY_VIDEO_BYTES: 100, STORY_VIDEO_MIME_TYPES: ['video/mp4'], REACTION_TYPES: ['love'] },
    '../models/StoryComment.js': { MAX_COMMENT_BODY: 1000 },
    '../services/friendStory.service.js': { friendStoryService: { reactions: async (...args) => { received = args; return { items: [], nextCursor: null }; } } },
    '../services/friendSafety.service.js': {}, '../services/story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg' } },
    '../utils/response.js': { ok: (res, value) => { res.value = value; } },
  });
  async function request(query, opts = {}) {
    const req = { auth: opts.auth !== false, friendsMember: opts.member === false ? null : me, params: { id: opts.id ?? String(storyId) }, query };
    const res = {};
    for (const fn of [...router.guards, ...handlers['GET /:id/reactions']]) {
      let error; await fn(req, res, (e) => { error = e; }); if (error) throw error;
    }
    return res.value;
  }
  await assert.rejects(request({}, { auth: false }), (e) => e.status === 401);
  await assert.rejects(request({}, { member: false }), (e) => e.status === 403);
  await request({}); assert.equal(received[3], 50);
  await request({ cursor: String(oid(10)), limit: '100' }); assert.equal(received[2], String(oid(10))); assert.equal(received[3], 100);
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { cursor: 'bad' }]) await assert.rejects(request(query));
  await assert.rejects(request({}, { id: 'bad' }));
}

(async () => {
  reset(); add(3); assert.equal((await service.reactions({ _id: author }, String(storyId), undefined, 50)).items.length, 1, 'author can view');
  assert.equal((await service.reactions(me, String(storyId), undefined, 50)).items.length, 1, 'friend can view');
  for (const setup of [() => { story = null; }, () => { friends = false; }, () => { authorBlocked = true; }, () => { story.hiddenByReportsAt = new Date(); }]) {
    reset(); setup(); await assert.rejects(service.reactions(me, String(storyId), undefined, 50), (e) => e.status === 404);
    assert.equal(calls.some(([name]) => name === 'blocked' || name === 'profiles'), false, 'ACL precedes reactor lookup');
  }
  reset();
  const first = add(3, 'love'); const blockedOutgoing = add(4); const missing = add(5, 'love', false);
  const blockedIncoming = add(6); const second = add(7, 'haha'); const third = add(8, 'wow');
  blocked = new Set([blockedOutgoing, blockedIncoming]);
  let page = await service.reactions(me, String(storyId), undefined, 1);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, first); assert.equal(page.items[0].type, 'love'); assert.equal(page.nextCursor, first);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['avatarUrl', 'displayName', 'id', 'type']);
  assert.equal(page.items[0].avatarUrl, 'signed:avatar-3');
  const queried = calls.filter(([name]) => name === 'profiles').flatMap(([, ids]) => ids);
  assert.ok(!queried.includes(blockedOutgoing) && !queried.includes(blockedIncoming), 'blocked IDs never loaded');
  page = await service.reactions(me, String(storyId), page.nextCursor.toUpperCase(), 1);
  assert.equal(page.items[0].id, second); assert.equal(page.items[0].type, 'haha'); assert.equal(page.nextCursor, second);
  page = await service.reactions(me, String(storyId), page.nextCursor, 1);
  assert.equal(page.items[0].id, third); assert.equal(page.nextCursor, null);
  page = await service.reactions(me, String(storyId), third, 1); assert.equal(page.items.length, 0); assert.equal(page.nextCursor, null);
  assert.ok(![first, second, third].includes(missing));
  reset(); for (let n = 3; n < 130; n++) add(n);
  const ids = []; let cursor;
  do { page = await service.reactions(me, String(storyId), cursor, 50); ids.push(...page.items.map((p) => p.id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.length, 127); assert.equal(new Set(ids).size, 127); assert.deepEqual(ids, [...ids].sort());
  await routeTests();
  console.log('PASS friend story reactions service and route');
})().catch((error) => { console.error(error); process.exitCode = 1; });
