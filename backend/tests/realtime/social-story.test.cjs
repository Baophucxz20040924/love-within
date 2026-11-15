'use strict';
// Actual story mutations with in-memory repository/transport stubs, no DB, provider or dotenv.
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
  if (path.dirname(dir) === dir) throw Error('Installed TypeScript not found');
}
const filename = path.resolve(__dirname, '../../src/services/friendStory.service.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const id = (value) => ({ toString: () => value, equals: (other) => value === other.toString() });
const author = id('author'), reader = id('reader'), storyId = id('story');
const story = { _id: storyId, authorId: author, hiddenByReportsAt: null, photos: [], reactions: new Map(), poll: null, commentCount: 0, createdAt: new Date() };
let calls = [], failCount = false, blocked = false;
const audience = {
  friendsOf: async (...args) => { calls.push(['friendsOf', ...JSON.parse(JSON.stringify(args))]); },
  own: async (...args) => { calls.push(['own', ...JSON.parse(JSON.stringify(args))]); },
};
const mocks = {
  'node:crypto': { randomUUID: () => 'uuid' }, mongoose: { Types: {} }, '../config/env.js': { env: {} },
  '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 }, '../models/Story.js': { MAX_STORY_PHOTOS: 10 },
  '../integrations/index.js': { getStorage: () => ({}) },
  '../repositories/friendship.repository.js': { friendshipRepository: { areFriends: async () => true } },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: { isBlockedBetween: async () => blocked, blockedIdsFor: async () => new Set() }, friendHiddenStoryRepository: {} },
  '../repositories/friendStory.repository.js': {
    friendStoryRepository: { findById: async () => story, setReaction: async () => { calls.push('reaction'); return story; }, incCommentCount: async () => { if (failCount) throw Error('count failed'); calls.push('count'); } },
    friendStoryCommentRepository: { create: async () => { calls.push('comment'); return { _id: id('comment'), authorId: reader, mentions: [], parentId: null, body: 'hi', createdAt: new Date() }; } },
  },
  '../repositories/user.repository.js': { userRepository: {} }, '../utils/date.js': {},
  '../utils/errors.js': { Errors: { notFound: () => Error('not found'), badRequest: () => Error('bad request') }, AppError: Error },
  '../utils/logger.js': { logger: { info() {}, warn() {} } },
  './notification.service.js': { notificationService: { emit: async () => calls.push('notification') } },
  './realtimeAudience.service.js': { realtimeAudience: audience }, './friends.service.js': {},
  './profile.service.js': { profileOf: () => ({}), profileService: { load: async () => new Map() } },
  './friendPoll.js': { previewIdsOf: () => [] }, './story.service.js': {},
};
// Load the real media helper without importing integrations, dotenv or provider code.
const mediaFilename = path.resolve(__dirname, '../../src/services/storyMedia.service.ts');
const mediaCode = ts.transpileModule(fs.readFileSync(mediaFilename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const mediaMod = { exports: {} };
Object.assign(mocks['../models/Story.js'], { MAX_STORY_ATTACHMENTS: 10, MAX_STORY_VIDEOS: 1, MAX_STORY_VIDEO_BYTES: 50 * 1024 * 1024 });
vm.runInNewContext(mediaCode, { module: mediaMod, exports: mediaMod.exports, Buffer, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked media ${name}`); return mocks[name]; } }, { filename: mediaFilename });
mocks['./storyMedia.service.js'] = mediaMod.exports;
const spansFilename = path.resolve(__dirname, '../../src/services/mentionSpans.ts');
const spansCode = ts.transpileModule(fs.readFileSync(spansFilename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const spansMod = { exports: {} };
vm.runInNewContext(spansCode, { module: spansMod, exports: spansMod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked spans ${name}`); return mocks[name]; } }, { filename: spansFilename });
mocks['./mentionSpans.js'] = spansMod.exports;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require(name) { assert.ok(Object.hasOwn(mocks, name), `unmocked ${name}`); return mocks[name]; } }, { filename });
const service = mod.exports.friendStoryService;
(async () => {
  await service.react({ _id: reader }, 'story', null);
  assert.equal(calls[0], 'reaction');
  assert.deepEqual(calls[1], ['friendsOf', 'author', ['friend-posts']]);
  calls = []; blocked = true;
  await assert.rejects(service.react({ _id: reader }, 'story', null));
  assert.deepEqual(calls, [], 'unauthorized write sends no hint');
  blocked = false; calls = []; failCount = true;
  await assert.rejects(service.addComment({ _id: reader }, 'story', { body: 'hi' }), /count failed/);
  assert.equal(calls[0], 'comment');
  assert.deepEqual(calls[1], ['friendsOf', 'author', ['friend-posts']], 'committed comment still signalled when count fails');
  calls = []; failCount = false; story.hiddenByReportsAt = new Date();
  await service.react({ _id: author }, 'story', null);
  assert.deepEqual(calls[1], ['own', 'author', 'friends', ['friend-posts']], 'hidden content remains author-only');
  console.log('PASS social story: audience, denied mutation, partial commit and hidden ACL');
})().catch((error) => { console.error(error); process.exitCode = 1; });
