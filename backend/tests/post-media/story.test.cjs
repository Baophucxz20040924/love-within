'use strict';
// Real TS services, models, route schemas and repository updates with isolated storage/DB mocks.
// Header fixtures here are deliberately NOT playable videos: they test container plausibility only.
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
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, console, require(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'mongoose') return mongoose;
    if (name.startsWith('node:')) return require(name);
    throw Error(`Unmocked dependency ${name} in ${file}`);
  } }, { filename });
  return mod.exports;
}
const errors = load('utils/errors.ts');
const storyModel = load('models/Story.ts');
const friendModel = load('models/FriendStory.ts', { './Story.js': storyModel });
const author = new Types.ObjectId(), friend = new Types.ObjectId(), other = new Types.ObjectId();
const coupleId = new Types.ObjectId(), storyId = new Types.ObjectId();
const me = { _id: author, timezone: 'UTC' };
const couple = { _id: coupleId, memberIds: [author, friend], timezone: 'UTC' };
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
const mov = Buffer.from('0000001466747970717420200000000069736f6d', 'hex');
const suffix = '2026-11/12345678-1234-4234-8234-123456789abc';
const video = (scope = 'friends', mimeType = 'video/mp4') => ({
  key: `${scope}/${scope === 'friends' ? author : coupleId}/story-videos/${suffix}.${mimeType === 'video/mp4' ? 'mp4' : mimeType === 'video/webm' ? 'webm' : 'mov'}`,
  mimeType, width: 640, height: 360,
});
const photo = (scope = 'friends', n = 0) => ({ key: `${scope}/${scope === 'friends' ? author : coupleId}/stories/a${n}.jpg`, width: 10, height: 10 });
let objects, calls, current, blocked, accepted, race, pollRace;
function reset() { objects = new Map(); calls = []; current = null; blocked = false; accepted = true; race = false; pollRace = false; }
reset();
function put(v, overrides = {}) {
  const bytes = v.mimeType === 'video/webm' ? webm : v.mimeType === 'video/quicktime' ? mov : mp4;
  objects.set(v.key, { size: bytes.length, mimeType: v.mimeType, bytes, ...overrides });
}
const storage = {
  async headObject(key) { calls.push(['head', key]); const value = objects.get(key); if (value?.headError) throw Error('storage head failure'); return value ? { size: value.size, mimeType: value.mimeType } : null; },
  async getObjectPrefix(key, maxBytes) { calls.push(['prefix', key, maxBytes]); const value = objects.get(key); if (value?.prefixError) throw Error('storage prefix failure'); return value.bytes; },
  async getObject() { throw Error('Full object download forbidden'); },
  async getDownloadUrl(key) { calls.push(['sign', key]); return { url: `signed:${key}` }; },
  async getUploadUrl(input) { calls.push(['upload', input]); return { uploadUrl: 'mock:put', expiresIn: 300 }; },
  async deleteObject(key) { calls.push(['delete', key]); },
};
const media = load('services/storyMedia.service.ts', {
  '../integrations/index.js': { getStorage: () => storage }, '../models/Story.js': storyModel, '../utils/errors.js': errors,
});
const profile = { profileOf: (_profiles, id) => ({ id: id.toString(), displayName: 'Friend' }), profileService: { load: async () => new Map() } };
const poll = load('services/friendPoll.ts', {
  '../models/FriendStory.js': friendModel, '../utils/errors.js': errors, './profile.service.js': profile,
});
const makeStory = (input = {}) => ({
  _id: storyId, authorId: author, coupleId, body: 'post', photos: [], videos: [], mentions: [], reactions: new Map(),
  mood: null, happenedOn: '2026-11-15', poll: null, commentCount: 0, hiddenByReportsAt: null,
  createdAt: new Date(), editedAt: null, contentRevision: 0, ...input,
});
const repo = {
  async create(input) { calls.push(['create', input]); current = makeStory({ ...input, poll: input.poll ? { ...input.poll, votes: new Map() } : null }); return current; },
  async findById() { return current; },
  async updateContent(_id, _author, content, revision, pollChange) {
    calls.push(['update', content, revision, pollChange]);
    assert.equal(revision, current.contentRevision ?? 0);
    if (race) { current = makeStory({ ...current, contentRevision: revision + 1 }); return null; }
    if (pollRace) return null;
    current = makeStory({ ...current, ...content, contentRevision: revision + 1,
      ...(pollChange === undefined ? {} : { poll: pollChange ? { ...pollChange, votes: new Map() } : null }) });
    return current;
  },
  async softDelete() { calls.push(['softDelete']); return current; },
};
const common = {
  '../config/env.js': { env: { s3: { maxUploadBytes: 5 * 1024 * 1024 } } },
  '../models/Story.js': storyModel,
  '../integrations/index.js': { getStorage: () => storage },
  '../repositories/user.repository.js': { userRepository: {
    findById: async () => ({ storiesSeenAt: new Date('2026-11-01T00:00:00.000Z') }),
    setStoriesSeenAt: async (...args) => calls.push(['seen', ...args]),
    findDisplayNames: async () => new Map(),
    findProfiles: async (ids) => new Map(ids.map((id) => [id.toString(), { displayName: 'Friend' }])),
  } },
  '../utils/date.js': { getLocalDate: () => '2026-11-15' },
  '../utils/errors.js': errors,
  '../utils/logger.js': { logger: { info() {}, warn() {} } },
  './storyMedia.service.js': media,
  './notification.service.js': { notificationService: {
    toPartner: async () => calls.push(['partner-notify']), emit: async (v) => calls.push(['notify', v.to.toString(), v.type]),
    forgetEntity: async () => {},
  } },
  './realtimeAudience.service.js': { realtimeAudience: {
    couple: async (...args) => calls.push(['couple-sse', ...args]), friendsOf: async (...args) => calls.push(['friend-sse', ...args]),
    own: async (...args) => calls.push(['own-sse', ...args]),
  } },
};
const friendService = load('services/friendStory.service.ts', {
  ...common,
  './mentionSpans.js': load('services/mentionSpans.ts', { '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 }, '../utils/errors.js': errors }),
  '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 },
  '../repositories/friendStory.repository.js': { friendStoryRepository: repo, friendStoryCommentRepository: {} },
  '../repositories/friendship.repository.js': { friendshipRepository: {
    areFriends: async () => accepted,
    listBetween: async (_id, ids) => accepted ? ids.map((id) => ({ status: 'accepted', other: new Types.ObjectId(id) })) : [],
  }, otherOf: (row) => row.other },
  '../repositories/friendSafety.repository.js': { friendBlockRepository: {
    isBlockedBetween: async () => blocked,
    blockedIdsFor: async () => blocked ? new Set([friend.toString()]) : new Set(),
  }, friendHiddenStoryRepository: {} },
  './friends.service.js': {}, './profile.service.js': profile, './friendPoll.js': poll,
  './story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } },
}).friendStoryService;
const coupleService = load('services/story.service.ts', {
  ...common,
  '../repositories/story.repository.js': { storyRepository: {
    ...repo,
    async findById(id) { return current?.coupleId.equals(id) ? current : null; },
    async updateContent(_couple, _id, _author, content) { calls.push(['update', content]); current = makeStory({ ...current, ...content }); return current; },
  }, storyCommentRepository: {} },
}).storyService;
const byScope = (scope) => scope === 'friends' ? {
  create: (input) => friendService.create(me, input), update: (input) => friendService.update(me, storyId.toString(), input),
  get: () => friendService.get(me, storyId.toString()), upload: (mime, size) => friendService.createVideoUploadUrl(me, mime, size),
  remove: () => friendService.remove(me, storyId.toString()),
} : {
  create: (input) => coupleService.create(couple, author.toString(), input), update: (input) => coupleService.update(couple, author.toString(), storyId.toString(), input),
  get: () => coupleService.get(couple, author.toString(), storyId.toString()), upload: (mime, size) => coupleService.createVideoUploadUrl(couple, mime, size),
  remove: () => coupleService.remove(couple, author.toString(), storyId.toString()),
};
const status = (expected) => (error) => error.status === expected;

test('model defaults keep legacy posts readable and enforce video descriptors', () => {
  for (const Model of [storyModel.Story, friendModel.FriendStory]) {
    const doc = new Model({ authorId: author, coupleId, happenedOn: '2026-11-15' });
    assert.equal(doc.videos.length, 0);
    doc.videos = [video('friends', 'video/quicktime')];
    assert.equal(doc.validateSync()?.errors['videos.0.mimeType'], undefined);
    doc.videos = [{ ...video(), mimeType: 'video/unknown' }];
    assert.ok(doc.validateSync().errors['videos.0.mimeType']);
  }
});

for (const scope of ['friends', 'couples']) {
  test(`${scope}: old/create/default, video-only, mixed and edit omission versus []`, async () => {
    reset(); const api = byScope(scope), v = video(scope);
    let view = await api.create({ body: 'old', photos: [] }); assert.equal(view.videos.length, 0);
    current = makeStory({ ...current, videos: undefined }); assert.equal((await api.get()).videos.length, 0);
    put(v); view = await api.create({ body: '', photos: [], videos: [v] });
    assert.equal(view.videos[0].url, `signed:${v.key}`); assert.equal(view.videos[0].mimeType, v.mimeType);
    assert.ok(calls.some((c) => c[0] === 'prefix' && c[2] === 64 * 1024));
    calls = []; await api.update({ body: 'legacy edit', photos: [] });
    assert.equal(current.videos[0].key, v.key); assert.equal(calls.filter((c) => c[0] === 'head' || c[0] === 'prefix').length, 0);
    assert.ok(calls.some((c) => c[0] === (scope === 'friends' ? 'friend-sse' : 'couple-sse')));
    calls = []; await api.update({ body: 'legacy edit', photos: [], videos: [v] });
    assert.equal(calls.filter((c) => c[0] === 'update').length, 0, 'unchanged videos are a no-op');
    await api.update({ body: 'legacy edit', photos: [], videos: [] });
    assert.equal(current.videos.length, 0); assert.equal(calls.filter((c) => c[0] === 'delete').length, 0, 'removed videos retained');
    const p = photo(scope); objects.set(p.key, { size: 10, mimeType: 'image/jpeg' });
    view = await api.create({ body: 'mixed', photos: [p], videos: [v] });
    assert.equal(view.photos.length, 1); assert.equal(view.videos.length, 1);
    calls = []; await api.remove(); assert.equal(calls.filter((c) => c[0] === 'delete').length, 0);
  });

  test(`${scope}: total count uses retained videos, rejects two videos and allows nine photos plus video`, async () => {
    reset(); const api = byScope(scope), v = video(scope); put(v);
    await api.create({ body: '', photos: [], videos: [v] });
    await assert.rejects(api.update({ body: 'ten', photos: Array.from({ length: 10 }, (_, i) => photo(scope, i)) }), status(400));
    await assert.rejects(api.create({ body: 'two', photos: [], videos: [v, v] }), status(400));
    const photos = Array.from({ length: 9 }, (_, i) => photo(scope, i));
    photos.forEach((p) => objects.set(p.key, { size: 1, mimeType: 'image/png' }));
    await api.update({ body: '', photos }); assert.equal(current.photos.length + current.videos.length, 10);
    await assert.rejects(api.update({ body: '', photos: [], videos: [] }), status(400));
  });

  test(`${scope}: new/changed descriptors validate storage; unchanged skip HEAD`, async () => {
    reset(); const api = byScope(scope), v = video(scope); put(v);
    await api.create({ body: 'x', photos: [], videos: [v] }); calls = [];
    await api.update({ body: 'x', photos: [], videos: [{ ...v, width: 800 }] });
    assert.equal(current.videos[0].width, 800); assert.equal(calls.filter((c) => c[0] === 'head').length, 1);
    put(v, { mimeType: 'image/jpeg' });
    await assert.rejects(api.update({ body: 'x', photos: [], videos: [{ ...v, height: 999 }] }), status(400));
    assert.equal(current.videos[0].height, 360);
    await assert.rejects(api.update({ body: 'x', photos: [], videos: [{ ...v, mimeType: 'video/webm' }] }), status(403));
  });

  test(`${scope}: video keys cannot enter photos and new photos need nonzero image HEAD`, async () => {
    reset(); const api = byScope(scope), v = video(scope); put(v);
    await assert.rejects(api.create({ body: 'x', photos: [{ key: v.key, width: 1, height: 1 }] }), status(403));
    const p = photo(scope);
    for (const metadata of [null, { size: 0, mimeType: 'image/jpeg' }, { size: 1, mimeType: 'video/mp4' }, { size: 1 }, { size: 6 * 1024 * 1024, mimeType: 'image/jpeg' }]) {
      if (metadata) objects.set(p.key, metadata); else objects.delete(p.key);
      await assert.rejects(api.create({ body: 'x', photos: [p] }), status(400));
    }
    current = makeStory({ photos: [p] }); objects.clear(); calls = [];
    await api.update({ body: 'retained legacy photo', photos: [p] });
    assert.equal(calls.filter((c) => c[0] === 'head').length, 0);
  });

  test(`${scope}: upload cap and MIME use distinct prefix without changing images`, async () => {
    reset(); const api = byScope(scope);
    for (const size of [0, -1, 50 * 1024 * 1024 + 1, Infinity, 1.5]) await assert.rejects(api.upload('video/mp4', size), status(400));
    for (const mime of ['video/unknown', 'image/jpeg', '__proto__']) await assert.rejects(api.upload(mime, 1), status(400));
    const result = await api.upload('video/webm', 50 * 1024 * 1024);
    assert.equal(result.maxBytes, 50 * 1024 * 1024);
    assert.ok(result.videoKey.startsWith(`${scope}/${scope === 'friends' ? author : coupleId}/story-videos/2026-11/`));
    assert.ok(result.videoKey.endsWith('.webm')); assert.equal(calls.filter((c) => c[0] === 'upload').length, 1);
    const movUpload = await api.upload('video/quicktime', 1);
    assert.ok(movUpload.videoKey.endsWith('.mov'));
    assert.equal(calls.at(-1)[1].mimeType, 'video/quicktime');
    const v = video(scope, 'video/quicktime'); put(v);
    const view = await api.create({ body: '', photos: [], videos: [v] });
    assert.equal(view.videos[0].mimeType, 'video/quicktime');
    assert.ok(calls.some(c => c[0] === 'prefix' && c[1] === v.key && c[2] === 64 * 1024));
  });
}

test('marking the feed seen signals only unread state, never the feed that triggers seen', async () => {
  reset();
  const result = await coupleService.markSeen(author.toString());
  assert.equal(result.previousSeenAt, '2026-11-01T00:00:00.000Z');
  assert.equal(calls.filter(c => c[0] === 'seen').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c => c[0] === 'own-sse'))), [
    ['own-sse', author.toString(), 'couple', ['story-unread']],
  ]);
});

test('shared moment photos remain attached and are never removed by story edits', async () => {
  reset(); const p = { ...photo('couples'), key: `couples/${coupleId}/moments/shared.jpg` };
  objects.set(p.key, { size: 2, mimeType: 'image/jpeg' });
  await coupleService.create(couple, author.toString(), { body: 'moment', photos: [p] }, { sharedPhotos: ['moments'] });
  objects.clear(); calls = [];
  await byScope('couples').update({ body: 'new words', photos: [p] });
  await byScope('couples').update({ body: 'keep object', photos: [] });
  assert.equal(calls.filter((c) => c[0] === 'head' || c[0] === 'delete').length, 0);
});

test('video scope, branch, extension, traversal and duplicate checks', async () => {
  reset(); const v = video(), prefix = media.storyVideoPrefix('friends', author.toString()); put(v);
  const invalid = [v.key.replace(author.toString(), other.toString()), v.key.replace('/story-videos/', '/stories/'),
    v.key.replace('.mp4', '.webm'), v.key.replace('/2026-11/', '/../2026-11/'), v.key.replace('/2026-11/', '/2026-13/'), `${v.key}?x=1`];
  for (const key of invalid) await assert.rejects(media.validateStoryVideos(prefix, [{ ...v, key }]), status(403));
  await assert.rejects(media.validateStoryVideos(prefix, [v, v]), status(400));
});

test('missing, empty, oversized, wrong MIME/header, oversized prefix and storage failure fail closed', async () => {
  reset(); const api = byScope('friends'), v = video();
  await assert.rejects(api.create({ body: '', photos: [], videos: [v] }), status(400));
  for (const overrides of [{ size: 0 }, { size: 50 * 1024 * 1024 + 1 }, { mimeType: 'video/webm' }, { mimeType: '' },
    { bytes: Buffer.from('not an mp4') }, { size: 100_000, bytes: Buffer.alloc(64 * 1024 + 1) },
    { bytes: Buffer.from('0000000866747970', 'hex') }, { size: 4 },
    { bytes: Buffer.from('000000006674797069736f6d00000200', 'hex') }]) {
    put(v, overrides); await assert.rejects(api.create({ body: '', photos: [], videos: [v] }), status(400));
  }
  for (const overrides of [{ headError: true }, { prefixError: true }]) {
    put(v, overrides); await assert.rejects(api.create({ body: '', photos: [], videos: [v] }), /storage .* failure/);
  }
  assert.equal(current, null, 'no bad media persisted');
});

test('bounded MP4 ftyp and EBML DocType webm plausibility, not substring sniffing', async () => {
  reset(); const prefix = media.storyVideoPrefix('friends', author.toString());
  const v = video('friends', 'video/webm'); put(v); await media.validateStoryVideos(prefix, [v]);
  for (const bytes of [Buffer.from('1a45dfa38b4282886d6174726f736b61', 'hex'), // DocType matroska
    Buffer.from('1a45dfa3ff4282847765626d', 'hex'), // unknown header size
    Buffer.from('1a45dfa3824282847765626d', 'hex'), // element beyond header
    Buffer.from('1a45dfa3874282ff7765626d', 'hex'), // unknown element size
    Buffer.from('1a45dfa3870000847765626d', 'hex'), // invalid element id
    Buffer.from('1a45dfa387428284f7e5e2ed', 'hex'), // high-bit bytes are not the ASCII DocType
    Buffer.from('webm1a45dfa3'), webm.subarray(0, 9)]) {
    put(v, { bytes, size: bytes.length }); await assert.rejects(media.validateStoryVideos(prefix, [v]), status(400));
  }
  const m = video(); const padded = Buffer.concat([Buffer.from('0000000866726565', 'hex'), mp4]);
  put(m, { bytes: padded, size: padded.length }); await media.validateStoryVideos(prefix, [m]);
});

test('MP4 ftyp brands reject HEIC, AVIF, MOV and unknown containers despite matching MIME/extension', async () => {
  reset(); const api = byScope('friends'), v = video();
  const fixture = (major, compatible = ['isom']) => {
    const bytes = Buffer.alloc(16 + compatible.length * 4);
    bytes.writeUInt32BE(bytes.length, 0); bytes.write('ftyp', 4, 'latin1'); bytes.write(major, 8, 'latin1');
    compatible.forEach((brand, i) => bytes.write(brand, 16 + 4 * i, 'latin1'));
    return bytes;
  };
  for (const major of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis', 'qt  ', 'zzzz', '    ']) {
    const bytes = fixture(major, ['isom', 'mp42']); put(v, { bytes, size: bytes.length });
    await assert.rejects(api.create({ body: '', photos: [], videos: [v] }), status(400), `reject foreign major brand ${major}`);
  }
  for (const compatible of ['heic', 'mif1', 'avif', 'avis', 'qt  ']) {
    const bytes = fixture('isom', ['mp42', compatible]); put(v, { bytes, size: bytes.length });
    await assert.rejects(api.create({ body: '', photos: [], videos: [v] }), status(400), `reject conflicting brand ${compatible}`);
  }
  assert.equal(current, null, 'wrong containers never persist');
  for (const major of ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash']) {
    const bytes = fixture(major, ['isom', 'mp42']); put(v, { bytes, size: bytes.length });
    assert.equal((await api.create({ body: '', photos: [], videos: [v] })).videos.length, 1, `accept MP4 major brand ${major}`);
  }
});

test('MOV requires bounded qt major ftyp, rejects mixed image brands and mismatched MP4', async () => {
  reset(); const prefix = media.storyVideoPrefix('friends', author.toString());
  const v = video('friends', 'video/quicktime');
  const box = (type, payload, extended = false) => {
    const b = Buffer.alloc((extended ? 16 : 8) + payload.length);
    b.writeUInt32BE(extended ? 1 : b.length, 0); b.write(type, 4, 'latin1');
    if (extended) b.writeBigUInt64BE(BigInt(b.length), 8);
    payload.copy(b, extended ? 16 : 8); return b;
  };
  const ftyp = (major, brands = [], extended = false) => box('ftyp', Buffer.concat([Buffer.from(major, 'latin1'), Buffer.alloc(4), ...brands.map(b => Buffer.from(b, 'latin1'))]), extended);
  for (const bytes of [mov, ftyp('qt  ', ['isom'], true), Buffer.concat(['free', 'skip', 'wide'].map(x => box(x, Buffer.alloc(0))).concat([mov]))]) {
    put(v, { bytes, size: bytes.length }); await media.validateStoryVideos(prefix, [v]);
  }
  for (const bytes of [mp4, webm, ftyp('heic', ['qt  ']), ftyp('avif', ['qt  ']), ftyp('qt  ', ['heic']), ftyp('qt  ', ['avif']),
    mov.subarray(0, 15), Buffer.from('00000000667479707174202000000000', 'hex'), Buffer.from('0000001166747970717420200000000000', 'hex'),
    Buffer.from('0000000166747970', 'hex'), Buffer.from('0000000166747970ffffffffffffffff', 'hex'),
    Buffer.from('000000016674797000000000000000187174202000000000', 'hex').subarray(0, 23)]) {
    put(v, { bytes, size: bytes.length }); await assert.rejects(media.validateStoryVideos(prefix, [v]), status(400));
  }
  for (const overrides of [{ size: 0 }, { size: 50 * 1024 * 1024 + 1 }, { mimeType: 'video/mp4' }, { size: 100_000, bytes: Buffer.alloc(64 * 1024 + 1) }]) {
    put(v, overrides); await assert.rejects(media.validateStoryVideos(prefix, [v]), status(400));
  }
  for (const key of [v.key.replace('.mov', '.mp4'), v.key.replace(author.toString(), other.toString()), v.key.replace('/story-videos/', '/stories/')]) {
    await assert.rejects(media.validateStoryVideos(prefix, [{ ...v, key }]), status(403));
  }
  const m = video(); put(m, { bytes: mov, size: mov.length });
  await assert.rejects(media.validateStoryVideos(prefix, [m]), status(400));
});

test('existing ACL must succeed before any signed video URL', async () => {
  reset(); current = makeStory({ videos: [video()] }); const viewer = { _id: friend };
  blocked = true; await assert.rejects(friendService.get(viewer, storyId.toString()), status(404));
  blocked = false; accepted = false; await assert.rejects(friendService.get(viewer, storyId.toString()), status(404));
  accepted = true; current.hiddenByReportsAt = new Date(); await assert.rejects(friendService.get(viewer, storyId.toString()), status(404));
  await assert.rejects(coupleService.get({ ...couple, _id: other }, friend.toString(), storyId.toString()), status(404));
  assert.equal(calls.filter((c) => c[0] === 'sign').length, 0);
  current.hiddenByReportsAt = null; assert.equal((await friendService.get(viewer, storyId.toString())).videos.length, 1);
  await assert.rejects(friendService.update(viewer, storyId.toString(), { body: 'x', photos: [], videos: [] }), status(403));
  await assert.rejects(coupleService.update(couple, friend.toString(), storyId.toString(), { body: 'x', photos: [], videos: [] }), status(403));
});

test('friend media edits preserve mentions, notification union, CAS and poll no-votes guards', async () => {
  reset(); const v = video(); put(v); const mention = { userId: friend.toString(), offset: 0, length: 7 };
  await friendService.create(me, { body: '@Friend', photos: [], videos: [v], mentions: [mention], poll: { options: ['A', 'B'], multi: false } });
  assert.ok(calls.some((c) => c[0] === 'notify' && c[2] === 'post_mention'));
  calls = []; await byScope('friends').update({ body: '@Friend', photos: [], videos: [] });
  assert.equal(current.mentions.length, 1); assert.equal(current.poll.options.length, 2);
  assert.ok(calls.some((c) => c[0] === 'own-sse' && c[1] === friend.toString() && c[3][0] === 'friend-notifications'));
  calls = []; race = true;
  await assert.rejects(byScope('friends').update({ body: '@Friend', photos: [], videos: [v] }), (e) => e.code === 'CONTENT_CONFLICT');
  assert.equal(calls.filter((c) => c[0] === 'notify' || c[0] === 'friend-sse').length, 0);
  race = false; pollRace = true;
  await assert.rejects(byScope('friends').update({ body: '@Friend', photos: [], videos: [v], poll: null }), (e) => e.code === 'POLL_LOCKED');
  pollRace = false; current.poll.votes.set(friend.toString(), [current.poll.options[0].id]);
  await assert.rejects(byScope('friends').update({ body: '@Friend', photos: [], videos: [v], poll: null }), (e) => e.code === 'POLL_LOCKED');
  await byScope('friends').update({ body: '@Friend', photos: [], videos: [v] });
  assert.equal(current.poll.votes.size, 1, 'media-only edit keeps votes');
});

test('repositories persist videos with the original couple scope and friend revision/poll atomic conditions', async () => {
  let captured;
  const model = { findOneAndUpdate: (...args) => { captured = args; return { exec: async () => null }; } };
  const friends = load('repositories/friendStory.repository.ts', {
    '../models/FriendStory.js': { FriendStory: model }, '../models/FriendStoryComment.js': {},
  }).friendStoryRepository;
  const content = { body: 'x', photos: [], videos: [video()], mentions: [] };
  await friends.updateContent('id', author, content, 0, null);
  assert.equal(captured[0].authorId, author); assert.equal(captured[0].$or[1].contentRevision.$exists, false);
  assert.ok(captured[0].$expr); assert.equal(captured[1].$inc.contentRevision, 1); assert.equal(captured[1].$set.videos, content.videos);
  await friends.updateContent('id', author, content, 3);
  assert.equal(captured[0].contentRevision, 3); assert.equal(captured[0].$expr, undefined); assert.equal(captured[1].$set.poll, undefined);
  const couples = load('repositories/story.repository.ts', {
    '../models/Story.js': { Story: model }, '../models/StoryComment.js': {},
  }).storyRepository;
  await couples.updateContent(coupleId, 'id', author, content);
  assert.equal(captured[0].coupleId, coupleId); assert.equal(captured[0].authorId, author); assert.equal(captured[1].$set.videos, content.videos);
});

for (const kind of ['story', 'friendStory']) test(`${kind} routes: video schema, omission, auth and shared limiter`, () => {
  const routes = []; const use = []; const marker = (name) => ({ name });
  const router = { use: (...args) => use.push(args) };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) router[method] = (url, ...handlers) => routes.push({ method, url, handlers });
  const auth = marker('auth'), membership = marker('membership'), limiter = marker('upload');
  load(`routes/${kind}.routes.ts`, {
    express: { Router: () => router }, zod,
    '../middleware/errorHandler.js': { asyncHandler: (fn) => fn }, '../middleware/auth.js': { requireAuth: auth },
    '../middleware/coupleContext.js': { requireCouple: membership }, '../middleware/friendsContext.js': { requireFriendsMember: membership },
    '../middleware/validate.js': { validate: (schemas) => ({ schemas }) },
    '../middleware/rateLimit.js': { storyUploadLimiter: limiter, friendStoryUploadLimiter: limiter },
    '../models/Story.js': storyModel, '../models/FriendStory.js': friendModel,
    '../models/StoryComment.js': { MAX_COMMENT_BODY: 2000 }, '../models/FriendStoryComment.js': { MAX_MENTIONS: 10 },
    '../services/story.service.js': { storyService: coupleService, STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } },
    '../services/friendStory.service.js': { friendStoryService: friendService }, '../services/friendSafety.service.js': {}, '../utils/response.js': {},
  });
  assert.equal(use[0][0], auth); assert.equal(use[0][1], membership);
  const upload = routes.find((r) => r.url === '/video-upload-url');
  assert.equal(upload.handlers[0], limiter);
  assert.equal(routes.find((r) => r.url === '/upload-url').handlers[0], limiter);
  const uploadSchema = upload.handlers.find((h) => h?.schemas)?.schemas.body;
  assert.equal(uploadSchema.safeParse({ mimeType: 'video/mp4', sizeBytes: 50 * 1024 * 1024 }).success, true);
  assert.equal(uploadSchema.safeParse({ mimeType: 'video/quicktime', sizeBytes: 1 }).success, true);
  assert.equal(uploadSchema.safeParse({ mimeType: 'video/mp4', sizeBytes: 50 * 1024 * 1024 + 1 }).success, false);
  const schema = routes.find((r) => r.method === 'patch' && r.url === '/:id').handlers.find((h) => h?.schemas).schemas.body;
  assert.equal(Object.hasOwn(schema.parse({ body: 'legacy' }), 'videos'), false);
  assert.equal(schema.parse({ videos: [] }).videos.length, 0);
  assert.equal(schema.safeParse({ videos: [video()] }).success, true);
  assert.equal(schema.safeParse({ videos: [video('friends', 'video/quicktime')] }).success, true);
  for (const videos of [null, [video(), video()], [{ ...video(), mimeType: 'video/unknown' }], [{ ...video(), width: 0 }], [{ ...video(), height: 20_001 }]]) {
    assert.equal(schema.safeParse({ videos }).success, false);
  }
});
