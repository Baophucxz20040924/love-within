'use strict';
// Actual service, route schemas, repository and Mongoose model; in-memory dependencies only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mongoose = require('mongoose');
const { Types } = mongoose;
const zod = require('zod');
const root = path.resolve(__dirname, '../../src');
function load(file, mocks = {}) {
  const filename = path.join(root, file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, URL, console, require(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'mongoose') return mongoose;
    if (name.startsWith('node:')) return require(name);
    throw Error(`Unmocked ${name} in ${file}`);
  } }, { filename });
  return mod.exports;
}
const errors = load('utils/errors.ts');
const storyCommentModel = load('models/StoryComment.ts');
const mentionModel = load('models/FriendStoryComment.ts', { './StoryComment.js': storyCommentModel });
const eventModel = load('models/FriendEvent.ts', { './StoryComment.js': storyCommentModel, './FriendStoryComment.js': mentionModel });
const spans = load('services/mentionSpans.ts', { '../models/FriendStoryComment.js': mentionModel, '../utils/errors.js': errors });
const oid = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const [creator, going, maybe, pending, declined, outsider, eventId] = [1,2,3,4,5,6,100].map(oid);
const people = [creator, going, maybe, pending, declined, outsider];
const names = new Map(people.map((p, i) => [String(p), ['Creator', 'Going', 'Maybe', 'Pending', 'Việt', 'Outsider'][i]]));
const key = (a, b) => [String(a), String(b)].sort().join(':');
let friends, blocks, missing, comments, emissions, attempts, searches, ev;
function reset() {
  friends = new Set([going, maybe, pending, declined].map(id => key(creator, id)));
  blocks = new Set(); missing = new Set(); comments = []; emissions = []; attempts = []; searches = [];
  ev = { _id: eventId, creatorId: creator, inviteeIds: [going, maybe, pending, declined], hiddenByReportsAt: null,
    rsvps: new Map([[String(going), 'going'], [String(maybe), 'maybe'], [String(declined), 'declined']]), status: 'active',
    pastAt: new Date(Date.now() + 3600000), startAt: new Date(), endAt: null, createdAt: new Date(), cover: null };
}
const blockedBetween = (a, b) => blocks.has(`${a}>${b}`) || blocks.has(`${b}>${a}`);
const profiles = { load: async ids => new Map(ids.filter(id => names.has(String(id)) && !missing.has(String(id))).map(id => [String(id), { id: String(id), displayName: names.get(String(id)), avatarUrl: null }])), of: async u => ({ id: String(u._id), displayName: u.displayName, avatarUrl: null }) };
const notification = { emit: async input => { attempts.push(input); if (!input.to.equals(input.actorId) && !blockedBetween(input.to, input.actorId)) emissions.push(input); } };
const service = load('services/friendEvent.service.ts', {
  '../config/env.js': {}, '../models/FriendEvent.js': eventModel, '../integrations/index.js': {},
  '../repositories/friendEvent.repository.js': { friendEventRepository: { findById: async id => String(id) === String(eventId) ? ev : null, incCommentCount: async () => {} },
    friendEventCommentRepository: { create: async input => { const c = { _id: oid(200 + comments.length), ...input, createdAt: new Date(), hiddenByReportsAt: null }; comments.push(c); return c; },
      findById: async (_event, id) => comments.find(c => String(c._id) === String(id)) ?? null,
      list: async (_event, viewer, excluded) => comments.filter(c => !excluded.some(id => id.equals(c.authorId)) && (!c.hiddenByReportsAt || c.authorId.equals(viewer))) } },
  '../repositories/friendship.repository.js': { pairKeyOf: key, friendshipRepository: {
    areFriends: async (a, b) => friends.has(key(a,b)),
    acceptedUnblockedPairKeys: async pairs => new Set(pairs.filter(([a,b]) => friends.has(key(a,b)) && !blockedBetween(a,b)).map(([a,b]) => key(a,b))),
  } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async (a,b) => blockedBetween(a,b),
    blockedIdsFor: async id => new Set(people.filter(p => blockedBetween(id,p)).map(String)) } },
  '../utils/date.js': {}, '../utils/errors.js': errors, '../utils/logger.js': { logger: { info() {}, warn() {} } },
  './mentionSpans.js': spans, './friends.service.js': { searchNameOf: s => s.toLowerCase() },
  '../repositories/user.repository.js': { userRepository: { findMembersByName: async (ids, pattern, limit) => { searches.push({ ids: ids.map(String), pattern, limit }); const re = new RegExp(pattern, 'i'); return ids.filter(id => names.has(String(id)) && !missing.has(String(id)) && re.test(names.get(String(id)))).slice(0,limit).map(id => ({ _id: id, displayName: names.get(String(id)) })); } } },
  './notification.service.js': { notificationService: notification }, './realtimeAudience.service.js': { realtimeAudience: { event: async () => {}, own: async () => {} } },
  './profile.service.js': { profileOf: (map,id) => map.get(String(id)) ?? { id: String(id), displayName: 'Unknown' }, profileService: profiles }, './story.service.js': {},
}).friendEventService;
const me = id => ({ _id: id });
const mention = (id, offset, length) => ({ userId: String(id), offset, length });
const bad = code => e => e.code === code;
const ids = list => list.map(p => p.id).sort();
const equalIds = (actual, expected) => assert.deepEqual(Array.from(actual).sort(), expected.map(String).sort());

test('event ACL, all RSVP states, non-mutual guests and bilateral revocation', async () => {
  reset();
  equalIds(ids(await service.mentionable(me(creator), String(eventId), '')), [going, maybe, pending, declined]);
  equalIds(ids(await service.mentionable(me(going), String(eventId), '')), [creator, maybe, pending, declined]);
  assert.equal(searches.at(-1).limit, 10);
  assert.equal(friends.has(key(going, declined)), false, 'guests need not be mutual friends');
  assert.equal((await service.mentionable(me(going), String(eventId), 'Vi')).length, 1);
  await service.mentionable(me(going), String(eventId), '.*'); assert.equal(searches.at(-1).pattern, '\\.\\*');
  await assert.rejects(service.mentionable(me(outsider), String(eventId), ''), e => e.status === 404);
  for (const direction of [[going, declined], [declined, going]]) {
    blocks.add(`${direction[0]}>${direction[1]}`);
    assert.ok(!ids(await service.mentionable(me(going), String(eventId), '')).includes(String(declined)));
    await assert.rejects(service.addComment(me(going), String(eventId), { body: '@Việt', mentions: [mention(declined, 0, 5)] }), bad('MENTION_NOT_ALLOWED'));
    blocks.clear();
  }
  friends.delete(key(creator, declined));
  assert.ok(!ids(await service.mentionable(me(going), String(eventId), '')).includes(String(declined)));
  await assert.rejects(service.mentionable(me(declined), String(eventId), ''), e => e.status === 404);
  friends.delete(key(creator, going));
  await assert.rejects(service.addComment(me(going), String(eventId), { body: 'hello' }), e => e.status === 404);
  friends.add(key(creator, going)); blocks.add(`${creator}>${going}`);
  await assert.rejects(service.mentionable(me(going), String(eventId), ''), e => e.status === 404);
  blocks.clear(); blocks.add(`${going}>${creator}`);
  await assert.rejects(service.mentionable(me(going), String(eventId), ''), e => e.status === 404);
  ev.hiddenByReportsAt = new Date();
  await assert.rejects(service.mentionable(me(going), String(eventId), ''), e => e.status === 404);
  assert.equal((await service.mentionable(me(creator), String(eventId), '')).length, 0);
});

test('trimmed UTF-16 spans, cap, overlap, names and eligibility', async () => {
  reset();
  const result = await service.addComment(me(going), String(eventId), { body: '  😀 @Việt  ', mentions: [mention(declined, 3, 5)] });
  assert.equal(result.body, '😀 @Việt'); assert.equal(result.mentions[0].offset, 3);
  assert.equal(comments[0].mentions[0].userId.toString(), String(declined));
  for (const input of [
    { body: '😀 @Việt', mentions: [mention(declined, 2, 5)] },
    { body: '@Việt', mentions: [mention(declined, 0, 5), mention(declined, 0, 5)] },
    { body: '@Việt', mentions: Array(11).fill(mention(declined, 0, 5)) },
    { body: '@Viet', mentions: [mention(declined, 0, 5)] },
    { body: '@Việt', mentions: [mention(declined, -1, 5)] },
    { body: '@Việt', mentions: [mention(declined, 0.5, 5)] },
  ]) await assert.rejects(service.addComment(me(going), String(eventId), input), bad('BAD_MENTION'));
  for (const [id, name] of [[going, 'Going'], [outsider, 'Outsider']])
    await assert.rejects(service.addComment(me(going), String(eventId), { body: `@${name}`, mentions: [mention(id, 0, name.length + 1)] }), bad('MENTION_NOT_ALLOWED'));
  missing.add(String(declined));
  await assert.rejects(service.addComment(me(going), String(eventId), { body: '@Việt', mentions: [mention(declined, 0, 5)] }), bad('MENTION_NOT_ALLOWED'));
  assert.equal(comments.length, 1, 'invalid spans never persist');
  missing.clear(); const text = Array(10).fill('@Việt').join(' ');
  const ten = Array.from({ length: 10 }, (_, i) => mention(declined, i * 6, 5));
  assert.equal((await service.addComment(me(going), String(eventId), { body: text, mentions: ten })).mentions.length, 10);
});

test('persistence, legacy comments, viewer-specific filtering and reply author flag', async () => {
  reset();
  const first = await service.addComment(me(going), String(eventId), { body: '@Việt', mentions: [mention(declined,0,5)] });
  await service.addComment(me(maybe), String(eventId), { body: 'reply', parentId: first.id });
  comments.push({ _id: oid(400), eventId, authorId: pending, parentId: null, body: 'legacy', createdAt: new Date(), hiddenByReportsAt: null });
  let list = await service.listComments(me(creator), String(eventId));
  assert.equal(list[0].mentions.length, 1); assert.equal(list[0].replies.length, 1); assert.equal(list[1].mentions.length, 0);
  assert.equal(list[0].canMentionAuthor, true);
  blocks.add(`${creator}>${declined}`); list = await service.listComments(me(creator), String(eventId));
  assert.equal(list[0].body, '@Việt'); assert.equal(list[0].mentions.length, 0);
  blocks.clear(); friends.delete(key(creator, going));
  list = await service.listComments(me(maybe), String(eventId));
  assert.equal(list[0].canMentionAuthor, false, 'former guest comments remain plain-repliable');
  friends.delete(key(creator, declined)); list = await service.listComments(me(maybe), String(eventId));
  assert.equal(list[0].mentions.length, 0);
  friends.add(key(creator, declined)); missing.add(String(declined));
  assert.equal((await service.listComments(me(maybe), String(eventId)))[0].mentions.length, 0);
});

test('recipient union deduplicates, includes mentioned non-going and produces no self notification', async () => {
  reset();
  await service.addComment(me(going), String(eventId), { body: '@Creator @Việt @Việt', mentions: [mention(creator, 0, 8), mention(declined, 9, 5), mention(declined, 15, 5)] });
  equalIds(emissions.map(x => String(x.to)), [creator, declined]);
  assert.ok(emissions.every(x => x.type === 'event_comment' && x.entityId.equals(eventId)));
  assert.equal(attempts.filter(x => x.to.equals(creator)).length, 1);
  assert.equal(attempts.filter(x => x.to.equals(declined)).length, 1);
  assert.ok(!emissions.some(x => x.to.equals(going)));
  emissions = []; await service.addComment(me(creator), String(eventId), { body: 'plain' });
  equalIds(emissions.map(x => String(x.to)), [going]);
});

test('Mongoose schema and repository persist spans, including legacy default', async () => {
  const legacy = new eventModel.FriendEventComment({ eventId, authorId: creator, body: 'legacy' });
  assert.equal(legacy.mentions.length, 0); assert.equal(legacy.validateSync(), undefined);
  const doc = new eventModel.FriendEventComment({ eventId, authorId: creator, body: '@Việt', mentions: [mention(declined, 0, 5)] });
  assert.equal(doc.validateSync(), undefined); assert.equal(String(doc.mentions[0].userId), String(declined));
  let captured;
  const repo = load('repositories/friendEvent.repository.ts', { '../models/FriendEvent.js': { FriendEvent: {}, FriendEventComment: { create: async input => { captured = input; return input; } } } }).friendEventCommentRepository;
  const input = { eventId, authorId: creator, parentId: null, body: '@Việt', mentions: [{ userId: declined, offset: 0, length: 5 }] };
  await repo.create(input); assert.equal(captured, input); assert.equal(captured.mentions[0].userId, declined);
});

test('actual route guards, limiter, bounded validation and forwarding', async () => {
  const routes = []; const guards = [];
  const router = { use: (...args) => guards.push(...args) };
  for (const method of ['get','post','put','patch','delete']) router[method] = (url,...handlers) => routes.push({ method,url,handlers });
  const auth = {}, member = {}, limiter = {}, readLimiter = {}; let passed;
  load('routes/friendEvent.routes.ts', { express: { Router: () => router }, zod,
    '../middleware/errorHandler.js': { asyncHandler: fn => fn }, '../middleware/auth.js': { requireAuth: auth }, '../middleware/friendsContext.js': { requireFriendsMember: member },
    '../middleware/validate.js': { validate: schemas => ({ schemas }) }, '../middleware/rateLimit.js': { expensiveReadLimiter: readLimiter, friendCommentLimiter: limiter },
    '../models/FriendEvent.js': eventModel, '../models/StoryComment.js': storyCommentModel, '../models/FriendStoryComment.js': mentionModel,
    '../services/friendEvent.service.js': { friendEventService: { addComment: async (...args) => { passed = args; return 'saved'; }, mentionable: async (...args) => { passed = args; return []; } } },
    '../services/story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg' } }, '../utils/response.js': { ok: (res, value, status) => Object.assign(res, { value, status }) },
  });
  assert.equal(guards[0], auth); assert.equal(guards[1], member);
  const post = routes.find(r => r.method === 'post' && r.url === '/:id/comments'); assert.equal(post.handlers[0], limiter);
  const schemas = post.handlers.find(h => h?.schemas).schemas;
  const payload = { body: '  😀 @Việt  ', mentions: [mention(declined, 3, 5)] };
  const parsed = schemas.body.parse(payload); assert.equal(parsed.body, '😀 @Việt'); assert.equal(parsed.mentions[0].offset, 3);
  assert.equal(schemas.body.parse({body:'legacy'}).mentions.length, 0);
  for (const mentions of [Array(11).fill(mention(declined,0,5)), [mention('bad',0,5)], [mention(declined,-1,5)], [mention(declined,0,1)]])
    assert.equal(schemas.body.safeParse({ body: 'x', mentions }).success, false);
  assert.equal(schemas.params.safeParse({id:'bad'}).success, false);
  const res = {}; await post.handlers.at(-1)({ friendsMember: me(going), params: { id: String(eventId) }, body: parsed }, res);
  assert.equal(res.status, 201); assert.equal(passed[2], parsed); assert.equal(passed[2].mentions[0].userId, String(declined));
  const picker = routes.find(r => r.method === 'get' && r.url === '/:id/mentionable'); assert.equal(picker.handlers[0], readLimiter);
  const query = picker.handlers.find(h => h?.schemas).schemas.query;
  assert.equal(query.parse({ q:' Việt ' }).q, 'Việt'); assert.equal(query.parse({}).q, ''); assert.equal(query.safeParse({ q:'x'.repeat(101) }).success, false);
  await picker.handlers.at(-1)({ friendsMember: me(going), params: { id: String(eventId) }, query: { q:'Việt' } }, {});
  assert.equal(passed[1], String(eventId)); assert.equal(passed[2], 'Việt');
});
