'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '../../src');
const id = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const uid = id(1), rid = id(2), author = id(3);
function loader(mocks) {
  const cache = new Map();
  return function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, Buffer, Date, console, require(name) {
      if (name === 'mongoose') return mongoose;
      if (name === 'node:crypto') return require(name);
      const key = path.posix.normalize(path.posix.join(path.posix.dirname(file), name)).replace(/\.js$/, '.ts');
      if (Object.hasOwn(mocks, key)) return mocks[key];
      assert.ok(['utils/errors.ts', 'utils/historyCursor.ts', 'utils/commentPage.ts'].includes(key), `Unmocked ${key}`);
      return load(key);
    } }, { filename: file });
    cache.set(file, module.exports); return module.exports;
  };
}
function match(row, filter) { return Object.entries(filter).every(([key, value]) => {
  if (key === '$and') return value.every(f => match(row, f));
  if (key === '$or') return value.some(f => match(row, f));
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
    return Object.entries(value).every(([op, v]) => op === '$nin' ? !v.some(x => String(x) === String(row[key]))
      : op === '$lt' ? row[key] < v : op === '$lte' ? row[key] <= v : assert.fail(op));
  }
  return row[key] == null ? value == null : String(row[key]) === String(value);
}); }
async function scenario(kind) {
  const isStory = kind === 'story', field = isStory ? 'storyId' : 'eventId';
  const rows = [];
  const make = (n, parentId = null) => ({ _id: id(n), [field]: rid, parentId, authorId: author, body: `row ${n}`,
    mentions: [], deletedAt: null, hiddenByReportsAt: null, createdAt: new Date('2026-11-19T00:00:00Z') });
  for (let n = 10; n < 531; n++) rows.push(make(n));
  for (let n = 1000; n < 1521; n++) rows.push(make(n, id(10)));
  let visible = true, blocked = new Set(), queryCount = 0, profileMax = 0, lastLimit;
  const Model = { find(filter) { queryCount++; let limit;
    return { sort(order) { assert.equal(order.createdAt, -1); assert.equal(order._id, -1); return this; },
      limit(n) { limit = lastLimit = n; return this; }, exec: async () => rows.filter(r => match(r, filter)).sort((a,b) => String(b._id).localeCompare(String(a._id))).slice(0, limit) };
  } };
  const noop = () => {};
  const mocks = {
    'config/env.ts': {}, 'integrations/index.ts': {}, 'models/Story.ts': {}, 'models/StoryComment.ts': {},
    'models/FriendStory.ts': { FriendStory: {} }, 'models/FriendStoryComment.ts': { FriendStoryComment: Model },
    'models/FriendEvent.ts': { FriendEventComment: Model, FriendEvent: {} },
    'services/mentionSpans.ts': {}, 'services/friends.service.ts': {}, 'services/friendPoll.ts': {},
    'services/storyMedia.service.ts': {}, 'services/story.service.ts': {},
    'repositories/user.repository.ts': {}, 'utils/date.ts': {},
    'repositories/friendship.repository.ts': { friendshipRepository: { areFriends: async () => true, acceptedUnblockedPairKeys: async () => new Set() }, pairKeyOf: (a,b) => [a,b].map(String).sort().join(':') },
    'repositories/friendSafety.repository.ts': { friendBlockRepository: { blockedIdsFor: async () => blocked, isBlockedBetween: async () => false } },
    'services/realtimeAudience.service.ts': {}, 'services/notification.service.ts': {},
    'utils/logger.ts': { logger: { info: noop, warn: noop } },
    'services/profile.service.ts': { profileService: { load: async ids => { profileMax = Math.max(profileMax, ids.length); return new Map([[String(author), { id: String(author), displayName: 'Fixture' }]]); } }, profileOf: (p, i) => p.get(String(i)) ?? { id: String(i), displayName: 'Missing' } },
  };
  const load = loader(mocks);
  const repoFile = isStory ? 'repositories/friendStory.repository.ts' : 'repositories/friendEvent.repository.ts';
  // Repository source only imports reviewed models and the small filter utility.
  const repos = load(repoFile), comments = repos[isStory ? 'friendStoryCommentRepository' : 'friendEventCommentRepository'];
  comments.findById = async (resource, cid) => rows.find(r => String(r[field]) === String(resource) && String(r._id) === String(cid) && !r.deletedAt) ?? null;
  repos[isStory ? 'friendStoryRepository' : 'friendEventRepository'].findById = async () => visible ? { _id: rid, authorId: uid, creatorId: uid, hiddenByReportsAt: null, inviteeIds: [author] } : null;
  mocks[repoFile] = repos;
  const service = load(`services/friend${isStory ? 'Story' : 'Event'}.service.ts`)[isStory ? 'friendStoryService' : 'friendEventService'];
  const me = { _id: uid };
  async function walk(rootId) {
    let cursor, all = [];
    do { const page = await service.listCommentsPage(me, String(rid), { limit: 20, cursor }, rootId); assert.equal(lastLimit, 21); all.push(...page.items); cursor = page.nextCursor; } while(cursor);
    assert.equal(all.length, 521); assert.equal(new Set(all.map(r => r.id)).size, 521);
    return all;
  }
  await walk(); await walk(String(id(10)));
  assert.ok(profileMax <= 20);
  const first = await service.listCommentsPage(me, String(rid), { limit: 20 });
  await assert.rejects(service.listCommentsPage({ _id: author }, String(rid), { limit: 20, cursor: first.nextCursor }), e => e.status === 400);
  await assert.rejects(service.listCommentsPage(me, String(rid), { limit: 20, cursor: first.nextCursor }, String(id(10))), e => e.status === 400);
  await assert.rejects(service.listCommentsPage(me, String(rid), { limit: 20, cursor: 'bad' }), e => e.status === 400);
  const before = queryCount;
  const context = await service.commentContext(me, String(rid), String(id(1100)));
  assert.equal(queryCount, before + 1); assert.equal(context.root.id, String(id(10))); assert.equal(context.replies.items[0].id, String(id(1100)));
  assert.equal(context.replies.items.length, 20); assert.ok(context.replies.nextCursor);
  const next = await service.listCommentsPage(me, String(rid), { limit: 20, cursor: context.replies.nextCursor }, context.root.id);
  assert.equal(next.items[0].id, String(id(1080)));
  rows[0].hiddenByReportsAt = new Date();
  await assert.rejects(service.commentContext(me, String(rid), String(id(1100))), e => e.status === 404);
  await assert.rejects(service.listCommentsPage(me, String(rid), { limit: 20 }, String(id(10))), e => e.status === 404);
  rows[0].hiddenByReportsAt = null; blocked = new Set([String(author)]);
  await assert.rejects(service.commentContext(me, String(rid), String(id(1100))), e => e.status === 404);
  assert.equal((await service.listCommentsPage(me, String(rid), { limit: 20 })).items.length, 0);
  blocked.clear(); rows[0].deletedAt = new Date();
  await assert.rejects(service.commentContext(me, String(rid), String(id(1100))), e => e.status === 404);
  visible = false;
  await assert.rejects(service.listCommentsPage(me, String(rid), { limit: 20, cursor: first.nextCursor }), e => e.status === 404);
}
(async () => { await scenario('story'); await scenario('event'); console.log('PASS threaded pages: 521 roots/replies per resource, ties, scoped cursors, bounded deep context and live root ACL'); })().catch(e => { console.error(e); process.exitCode = 1; });
