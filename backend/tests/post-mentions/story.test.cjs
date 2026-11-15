'use strict';
// Actual story service with the realtime harness's isolated transpilation and repository stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Types } = require('mongoose');
const filename = path.resolve(__dirname, '../../src/services/friendStory.service.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const author = new Types.ObjectId(), friend = new Types.ObjectId(), stranger = new Types.ObjectId(), viewer = new Types.ObjectId(), storyId = new Types.ObjectId();
const names = new Map([[friend.toString(), { displayName: 'Việt' }], [stranger.toString(), { displayName: 'Khác' }]]);
let current, calls, blocked, accepted, race, pollRace, lookupFailsAfterWrite;
const reset = () => { current = null; calls = []; blocked = new Set(); accepted = new Set([friend.toString()]); race = false; pollRace = false; lookupFailsAfterWrite = false; };
const me = { _id: author };
const mention = (userId, offset, length) => ({ userId: userId.toString(), offset, length });
const makeStory = (input) => ({ _id: storyId, authorId: author, hiddenByReportsAt: null, photos: [], reactions: new Map(), poll: null, commentCount: 0, createdAt: new Date(), editedAt: null, contentRevision: 0, ...input });
const mocks = {
  'node:crypto': { randomUUID: () => 'uuid' }, mongoose: { Types }, '../config/env.js': { env: { s3: { maxUploadBytes: 100 } } },
  '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 }, '../models/Story.js': { MAX_STORY_PHOTOS: 10 },
  '../integrations/index.js': { getStorage: () => ({ headObject: async () => ({size: 1, mimeType: 'image/jpeg'}), getDownloadUrl: async () => ({url:'url'}), deleteObject: async () => {} }) },
  '../repositories/friendship.repository.js': { friendshipRepository: {
    areFriends: async () => true,
    friendIds: async () => [...accepted].map((id) => new Types.ObjectId(id)),
    listBetween: async (_a, ids) => ids.filter((id) => accepted.has(id)).map((id) => ({ status: 'accepted', other: new Types.ObjectId(id) })),
  }, otherOf: (row) => row.other },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async () => false, blockedIdsFor: async () => blocked }, friendHiddenStoryRepository: {} },
  '../repositories/friendStory.repository.js': { friendStoryRepository: {
    findById: async () => { if (lookupFailsAfterWrite && current?.contentRevision > 0) throw Error('lookup failed'); return current; },
    create: async (input) => (current = makeStory(input)),
    updateContent: async (_id, _author, content, rev, poll) => {
      assert.equal(rev, current.contentRevision ?? 0);
      if (race) { current = makeStory({ ...current, body: 'concurrent', contentRevision: rev + 1 }); return null; }
      if (pollRace) return null;
      current = makeStory({ ...current, ...content, ...(poll === undefined ? {} : {poll}), contentRevision: rev + 1 }); return current;
    },
  }, friendStoryCommentRepository: {} },
  '../repositories/user.repository.js': { userRepository: { findProfiles: async (ids) => new Map(ids.filter((id) => names.has(id.toString())).map((id) => [id.toString(), names.get(id.toString())])), findMembersByName: async (ids) => ids.map((_id) => ({ _id, ...names.get(_id.toString()) })) } },
  '../utils/date.js': {}, '../utils/errors.js': { Errors: { notFound: () => Error('not found'), badRequest: () => Error('bad request') }, AppError: class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } } },
  '../utils/logger.js': { logger: { info() {}, warn() {} } },
  './notification.service.js': { notificationService: { emit: async (input) => calls.push(['notify', input.to.toString(), input.type]), forgetEntity: async () => {} } },
  './realtimeAudience.service.js': { realtimeAudience: { friendsOf: async () => {}, own: async (...args) => calls.push(['own', ...args]) } },
  './friends.service.js': { searchNameOf: (s) => s },
  './profile.service.js': { profileOf: () => ({}), profileService: { load: async () => new Map(), of: async (u) => u } },
  './friendPoll.js': { previewIdsOf: () => [], pollEdit: (_old, input) => input === undefined ? undefined : input, pollErrors: { locked: () => Error('poll locked'), noQuestion: () => Error('no question') }, newPoll: (p) => p, pollView: () => ({}) }, './story.service.js': {},
};
// Keep the actual media helper in the service graph; storage remains mocked (no providers).
const mediaFilename = path.resolve(__dirname, '../../src/services/storyMedia.service.ts');
const mediaCode = ts.transpileModule(fs.readFileSync(mediaFilename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const mediaMod = { exports: {} };
Object.assign(mocks['../models/Story.js'], { MAX_STORY_ATTACHMENTS: 10, MAX_STORY_VIDEOS: 1, MAX_STORY_VIDEO_BYTES: 50 * 1024 * 1024 });
vm.runInNewContext(mediaCode, { module: mediaMod, exports: mediaMod.exports, Buffer, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked media ${name}`); return mocks[name]; } }, { filename: mediaFilename });
mocks['./storyMedia.service.js'] = mediaMod.exports;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
const service = mod.exports.friendStoryService;
(async () => {
  reset();
  let view = await service.create(me, { body: '  😀 @Việt @Việt  ', photos: [], mentions: [mention(friend, 3, 5), mention(friend, 9, 5)] });
  assert.equal(view.body, '😀 @Việt @Việt'); assert.equal(view.mentions.length, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'notify'), [['notify', friend.toString(), 'post_mention']]);
  calls = []; await service.update(me, storyId.toString(), { body: '😀 @Việt @Việt', photos: [] }); assert.equal(calls.length, 0);
  names.set(friend.toString(), {displayName:'Renamed'}); blocked.add(friend.toString());
  await service.update(me, storyId.toString(), { body: '😀 @Việt @Việt', photos: [{key:`friends/${author}/stories/a`, width:1, height:1}], mentions: [mention(friend, 3, 5), mention(friend, 9, 5)] });
  assert.equal(current.mentions.length, 2, 'retained spans survive rename and block');
  view = await service.get({ _id: viewer }, storyId.toString()); assert.equal(view.mentions.length, 0, 'blocked spans hidden on non-poll post');
  await service.update(me, storyId.toString(), { body: 'different', photos: [], }); assert.equal(current.mentions.length, 0, 'legacy body change clears spans');
  assert.ok(calls.some((c) => c[0] === 'own' && c[1] === friend.toString() && c[3][0] === 'friend-notifications'));
  reset(); names.set(friend.toString(), {displayName:'Việt'});
  await service.create(me, {body:'@Việt', photos:[], mentions:[mention(friend,0,5)]});
  await service.update(me, storyId.toString(), {body:'@Việt', photos:[], mentions:[]}); assert.equal(current.mentions.length, 0);
  await assert.rejects(service.create(me, {body:'@Khác', photos:[], mentions:[mention(stranger,0,5)]}), /MENTION_NOT_ALLOWED/);
  blocked.add(friend.toString()); await assert.rejects(service.create(me, {body:'@Việt', photos:[], mentions:[mention(friend,0,5)]}), /MENTION_NOT_ALLOWED/);
  blocked.clear(); await assert.rejects(service.create(me, {body:'😀 @Việt', photos:[], mentions:[mention(friend,2,5)]}), /BAD_MENTION/);
  await assert.rejects(service.create(me, {body:'@Việt', photos:[], mentions:[mention(friend,0,5), mention(friend,0,5)]}), /BAD_MENTION/);
  await assert.rejects(service.create(me, {body:'@Việt', photos:[], mentions:Array(11).fill(mention(friend,0,5))}), /BAD_MENTION/);
  await service.create(me, {body:'old', photos:[]}); assert.equal(current.mentions.length, 0);
  calls = []; race = true; await assert.rejects(service.update(me, storyId.toString(), {body:'new', photos:[]}), (e) => e.status === 409 && e.code === 'CONTENT_CONFLICT');
  assert.equal(calls.filter((c) => c[0] === 'notify').length, 0, 'failed CAS must not notify');
  race = false; pollRace = true; await assert.rejects(service.update(me, storyId.toString(), {body:'new', photos:[], poll:null}), /poll locked/);
  reset(); await service.create(me, {body:'old', photos:[]});
  calls = []; lookupFailsAfterWrite = true;
  const saved = await service.update(me, storyId.toString(), {body:'@Việt', photos:[], mentions:[mention(friend, 0, 5)]});
  assert.equal(saved.body, '@Việt', 'post-commit notification lookup failure does not fail the edit');
  assert.equal(current.contentRevision, 1); assert.equal(calls.filter((c) => c[0] === 'notify').length, 0);
  reset(); accepted.add(stranger.toString()); blocked.add(stranger.toString());
  const results = await service.draftMentionable(me, '');
  assert.equal(results.length, 1); assert.equal(results[0]._id.toString(), friend.toString(), 'draft picker excludes blocked friends');
  console.log('PASS post mentions story service');
})().catch((error) => { console.error(error); process.exitCode = 1; });
