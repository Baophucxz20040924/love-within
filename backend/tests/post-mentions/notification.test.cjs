'use strict';
// Isolated TypeScript service tests; no database, env, network, or real push provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
for (let dir = __dirname; ; dir = path.dirname(dir)) {
  for (const base of [dir, path.join(dir, 'backend'), path.join(dir, 'frontend')]) {
    try { ts = require(require.resolve('typescript', { paths: [base] })); break; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  if (ts) break;
  if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
}
function load(relative, mocks) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
const id = (value) => ({ toString: () => value, equals: (other) => value === other.toString() });
const recipient = id('recipient'), author = id('author'), post = id('post'), notif = id('notification');
const rules = load('config/notificationTypes.ts', {});
const sets = { GROUPED_NOTIFICATION_TYPES: new Set(['story_reaction']), OUTING_NOTIFICATION_TYPES: new Set(), SYSTEM_NOTIFICATION_TYPES: new Set(['poll_closed']), EVENT_NOTIFICATION_TYPES: new Set() };

async function repositoryTest() {
  let row, duplicate = false, failure = false, writes = [];
  const model = { updateOne(filter, update, options) { return { async exec() {
    writes.push({ filter, update, options });
    if (failure) throw Error('database');
    if (duplicate) throw Object.assign(Error('race'), { code: 11000 });
    if (row) return { upsertedCount: 0 };
    row = { ...update.$setOnInsert }; return { upsertedCount: 1 };
  } }; } };
  const { friendNotificationRepository: repo } = load('repositories/friendNotification.repository.ts', {
    mongoose: {}, '../models/FriendNotification.js': { FriendNotification: model },
  });
  assert.equal(await repo.addPostMentionOnce(recipient, author, post), true);
  assert.equal(writes[0].filter.groupKey, 'post_mention:post');
  assert.equal(writes[0].options.upsert, true);
  assert.deepEqual(Object.keys(writes[0].update), ['$setOnInsert']);
  assert.equal(row.type, 'post_mention');
  row.readAt = new Date(123); row.updatedAt = new Date(456);
  assert.equal(await repo.addPostMentionOnce(recipient, author, post), false);
  assert.equal(row.readAt.getTime(), 123); assert.equal(row.updatedAt.getTime(), 456);
  duplicate = true;
  assert.equal(await repo.addPostMentionOnce(recipient, author, post), false);
  assert.equal(writes.length, 3, 'duplicate key is not retried as an update');
  duplicate = false; failure = true;
  await assert.rejects(repo.addPostMentionOnce(recipient, author, post), /database/);
}

async function emissionTest() {
  let inserted = true, blocked = false, fail = false, calls = [], job;
  const repo = { async addPostMentionOnce(...args) { calls.push('insert'); assert.equal(args[2], post); if (fail) throw Error('store'); return inserted; } };
  const { notificationService } = load('services/notification.service.ts', {
    mongoose: {}, '../config/notificationTypes.js': rules, '../models/FriendNotification.js': sets,
    '../repositories/friendNotification.repository.js': { friendNotificationRepository: repo },
    '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async () => blocked } },
    '../utils/logger.js': { logger: { warn() {} } }, './push.service.js': { pushService: { enqueue(j) { job = j; calls.push('push'); } } },
    './realtimeAudience.service.js': { realtimeAudience: { own: async () => calls.push('invalidate') } },
  });
  const input = { space: 'friends', to: recipient, type: 'post_mention', actorId: author, entityId: post, push: { body: 'private content', url: '/wrong' } };
  await notificationService.emit(input);
  assert.deepEqual(calls, ['insert', 'invalidate', 'push']);
  assert.equal(job.group, 'social'); assert.equal(job.content.url, '/friends/posts/post');
  assert.equal(job.content.body('Lan'), 'Lan đã nhắc đến bạn trong một bài viết');
  assert.equal(job.content.tag, 'post:post');
  calls = []; inserted = false; await notificationService.emit(input); assert.deepEqual(calls, ['insert']);
  calls = []; blocked = true; await notificationService.emit(input); assert.deepEqual(calls, []);
  blocked = false; fail = true; await notificationService.emit(input); assert.deepEqual(calls, ['insert']);
  calls = []; fail = false; await notificationService.emit({ ...input, to: author }); assert.deepEqual(calls, []);
  await notificationService.emit({ ...input, entityId: null }); assert.deepEqual(calls, []);
}

async function preferencesTest() {
  let social = false, preview = true, sent = [];
  const defaults = { couple: {}, friends: { social: true, events: true, messages: true, preview: false }, quiet: { enabled: false, from: '23:00', to: '07:00' } };
  const { pushService } = load('services/push.service.ts', {
    mongoose: {}, '../config/notificationTypes.js': rules,
    '../integrations/index.js': { getPush: () => ({ enabled: true, send: async (_endpoint, payload) => { sent.push(JSON.parse(payload)); return { status: 'ok' }; } }) },
    '../models/User.js': { DEFAULT_PUSH_SETTINGS: defaults },
    '../repositories/pushSubscription.repository.js': { pushSubscriptionRepository: { listFor: async () => [{ _id: id('device'), endpoint: 'mock', keys: {} }], markSuccess: async () => {} } },
    '../repositories/user.repository.js': { userRepository: { findPushProfile: async () => ({ pushSettings: { friends: { social, preview } } }), findDisplayNames: async () => new Map([['author', 'Lan']]) } },
    '../utils/date.js': { getLocalTime: () => '12:00' }, '../utils/errors.js': { AppError: Error },
    '../utils/logger.js': { logger: { debug() {}, warn() {} } },
  });
  const job = { userId: recipient, space: 'friends', group: rules.FRIENDS_PUSH_RULES.post_mention.group, type: 'post_mention', actorId: author, content: { body: (name) => `${name} đã nhắc đến bạn trong một bài viết`, url: '/friends/posts/post' } };
  async function flush() { while (pushService.pendingCount()) await new Promise((resolve) => setImmediate(resolve)); }
  pushService.enqueue(job); await flush(); assert.equal(sent.length, 0, 'social preference suppresses push');
  social = true; pushService.enqueue(job); await flush(); assert.equal(sent.length, 1); assert.equal(sent[0].url, '/friends/posts/post');
  assert.equal(sent[0].body, 'Lan đã nhắc đến bạn trong một bài viết');
  preview = false; pushService.enqueue(job); await flush(); assert.equal(sent[1].body, 'Bạn có thông báo mới'); assert.equal(sent[1].url, '/friends/notifications');
}

async function visibilityTest() {
  let story = { _id: post, authorId: author, hiddenByReportsAt: null, deletedAt: null, mentions: [{ userId: recipient }], body: 'Private post body' };
  let status = 'accepted', blocked = new Set(), projections = [];
  const candidate = { _id: notif, type: 'post_mention', entityId: post, actorIds: [author], recentActorIds: [author], readAt: null, updatedAt: new Date() };
  const model = { find(query) { return { select(fields) { projections.push(fields); return this; }, lean() { return this; }, async exec() {
    return story && !story.deletedAt && query._id.$in.some((item) => item.equals(story._id)) ? [story] : [];
  } }; } };
  const { friendNotificationsService: svc } = load('services/friendNotifications.service.ts', {
    mongoose: { Types: { ObjectId: function ObjectId() {} } }, '../models/FriendNotification.js': sets,
    '../models/FriendEvent.js': { FriendEvent: {} }, '../models/FriendStory.js': { FriendStory: model }, '../models/FriendStoryComment.js': { FriendStoryComment: {} },
    '../repositories/friendNotification.repository.js': { friendNotificationRepository: { list: async () => [candidate], listSince: async () => [candidate] } },
    '../repositories/friendship.repository.js': { friendshipRepository: { listBetween: async () => status ? [{ status }] : [], countIncomingPending: async () => 0 }, otherOf: () => author },
    '../repositories/friendSafety.repository.js': { friendBlockRepository: { blockedIdsFor: async () => blocked } },
    '../repositories/user.repository.js': { userRepository: {} }, '../utils/errors.js': { Errors: {} },
    './friendOuting.service.js': { friendOutingService: {} }, './realtimeAudience.service.js': { realtimeAudience: {} },
    './profile.service.js': { profileService: { load: async () => new Map() }, profileOf: (_profiles, who) => ({ id: who.toString() }) },
  });
  const me = { _id: recipient, friendsNotifSeenAt: null };
  async function check(expected) {
    projections = [];
    const list = await svc.list(me);
    assert.equal(list.items.length, expected);
    if (expected) { assert.equal(list.items[0].entity.kind, 'story'); assert.equal(list.items[0].entity.id, 'post'); assert.equal(list.items[0].entity.excerpt, 'Private post body'); }
    assert.ok(projections.every((p) => p.includes('body')), 'list requests body for excerpt');
    projections = [];
    assert.equal((await svc.unread(me)).notifications, expected);
    assert.ok(projections.every((p) => !p.split(' ').includes('body')), 'badge must not request body');
  }
  await check(1);
  story.mentions = []; await check(0); story.mentions = [{ userId: recipient }];
  status = 'pending'; await check(0); status = null; await check(0); status = 'accepted';
  blocked = new Set(['author']); await check(0); blocked = new Set();
  story.hiddenByReportsAt = new Date(); await check(0); story.hiddenByReportsAt = null;
  story.deletedAt = new Date(); await check(0); story.deletedAt = null;
  story = null; await check(0);
}

(async () => {
  await repositoryTest(); await emissionTest(); await preferencesTest(); await visibilityTest();
  console.log('PASS post mention notifications: insert-once, push, ACL, list and badge');
})().catch((error) => { console.error(error); process.exitCode = 1; });
