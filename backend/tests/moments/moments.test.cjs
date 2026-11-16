'use strict';
// Unit only: repositories, storage, notifications, configuration and clocks are explicit mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { Types, Schema } = require('mongoose');
function load(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Set, Map, Error, console, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked dependency ${name}`); return mocks[name]; } }, { filename });
  return mod.exports;
}
const dates = load('utils/date.ts');
const errors = load('utils/errors.ts');
const model = load('models/DuoMoment.ts', { mongoose: { Schema, model: () => ({}) } });
const uid = new Types.ObjectId(), partner = new Types.ObjectId(), cid = new Types.ObjectId();
const couple = { _id: cid, memberIds: [uid, partner], timezone: 'UTC', createdAt: new Date('2026-01-01'), status: 'active' };
function harness() {
  let clock = Date.parse('2026-11-15T09:00:00Z'), dbClock = null, rng = 0, seq = 0;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const calls = { storage: [], post: [], quest: [], notification: [], stories: [], deletes: [], ensure: [] };
  let day, failCas = false;
  const repo = {
    findDay: async (coupleId, date) => String(coupleId) === String(cid) && day?.localDate === date ? day : null,
    ensureDay: async (candidate) => { calls.ensure.push(candidate); return day ??= candidate; },
    listRange: async () => [day], bothDays: async () => [],
    addPost: async (...args) => {
      calls.post.push(args);
      const s = day.sessions.find((s) => s.id === args[2]);
      const now = dbClock ?? clock;
      if (failCas || now < +s.promptAt || now >= +s.closesAt || s.posts.some((p) => String(p.userId) === String(args[3].userId))) return null;
      s.posts.push({ ...args[3], postedAt: new Date(now), lateMin: now < +s.rewardEndsAt ? 0 : Math.max(1, Math.ceil((now - s.rewardEndsAt) / 60000)) });
      return day;
    },
    setStory: async (_c, _id, sid, expected, storyId) => {
      const s = day.sessions.find((s) => s.id === sid);
      if (failCas || s.storyId !== expected) return null;
      s.storyId = storyId; return day;
    },
  };
  const storage = { getDownloadUrl: async (key) => { calls.storage.push(key); return { url: `signed:${key}` }; },
    headObject: async () => ({ size: 1 }), getUploadUrl: async ({key}) => ({uploadUrl: 'mock', expiresIn: 60, key}) };
  const service = load('services/moment.service.ts', {
    './realtimeAudience.service.js': { realtimeAudience: { couple: async () => {} } },
    'node:crypto': { randomInt: (max) => rng === 'max' ? max - 1 : rng, randomUUID: () => `s${++seq}` },
    mongoose: { Types }, '../config/env.js': { env: { s3: { maxUploadBytes: 5000 } } }, '../models/DuoMoment.js': model,
    '../integrations/index.js': { getStorage: () => storage }, '../repositories/moment.repository.js': { momentRepository: repo },
    '../repositories/story.repository.js': { storyRepository: { aliveIds: async (_c, ids) => new Set(ids.map(String)), softDelete: async (...args) => calls.deletes.push(args) } },
    '../repositories/user.repository.js': { userRepository: { findDisplayNames: async () => new Map() } },
    './notification.service.js': { notificationService: { toPartner: async (...args) => calls.notification.push(args) } },
    './quest.service.js': { DUO_MOMENT_QUEST_KEY: 'duo_moment', questService: { refresh: async (...args) => calls.quest.push(args) } },
    './story.service.js': { STORY_IMAGE_TYPES: { 'image/jpeg': 'jpg' }, storyService: { create: async (...args) => { calls.stories.push(args); return { id: String(new Types.ObjectId()) }; } } },
    '../utils/date.js': dates, '../utils/errors.js': errors, '../utils/logger.js': { logger: { info() {} } },
  }, { Date: Clock });
  day = { ...service.newMomentDay(cid, '2026-11-15', 'UTC'), _id: new Types.ObjectId() };
  const target = () => ({ localDate: day.localDate, sessionId: day.sessions[0].id });
  return { ...service, Clock, calls, repo, storage, target, get day() { return day; }, set day(v) { day = v; },
    setClock: value => clock = +new Date(value), setDbClock: value => dbClock = +new Date(value), setRng: value => rng = value, failCas: () => failCas = true,
    input: () => ({ ...target(), key: `couples/${cid}/moments/${day.localDate}/${day.sessions[0].id}/${uid}/photo.jpg`, width: 10, height: 10, caption: ' caption ' }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, e => e.code === code);

test('one immutable random daily prompt, inclusive extremes, reward cutoff and timezone/DST midnight', () => {
  const h = harness();
  for (const zone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York', 'Pacific/Kiritimati']) {
    for (const date of ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01', '2026-11-15']) {
      for (const rng of [0, 'max']) {
        h.setRng(rng);
        const d = h.newMomentDay(cid, date, zone, new Date(`${date}T23:59:00Z`));
        assert.equal(d.sessions.length, 1); assert.equal(d.timezone, zone); assert.equal(d.scheduleVersion, 3);
        const s = d.sessions[0];
        assert.equal(dates.getLocalTime(s.promptAt, zone), rng === 0 ? '09:00' : '21:00');
        assert.equal(dates.getLocalDate(s.promptAt, zone), date);
        assert.equal(s.rewardEndsAt - s.promptAt, 1800000); assert.equal(s.notifiedAt, null);
        assert.equal(dates.getLocalTime(s.closesAt, zone), '00:00');
        assert.equal(dates.getLocalDate(s.closesAt, zone), dates.addDays(date, 1));
      }
    }
  }
  h.setRng(0);
  assert.equal(h.newMomentDay(cid, '2026-03-08', 'America/New_York').sessions[0].closesAt.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(h.newMomentDay(cid, '2026-11-01', 'America/New_York').sessions[0].closesAt.toISOString(), '2026-11-02T05:00:00.000Z');
});
test('saved schedule survives reload/timezone edits and future time/ID remain private; pulse has both cutoffs', async () => {
  const h = harness(); const before = JSON.stringify(h.day);
  h.setClock('2026-11-15T08:59:59Z');
  assert.equal((await h.momentService.today(couple, String(uid))).sessions.length, 0);
  const waiting = await h.momentService.pulse(couple, String(uid));
  assert.equal(waiting.sessionId, null); assert.equal(waiting.rewardEndsAt, null); assert.equal(waiting.closesAt, null);
  h.setClock('2026-11-15T09:00:00Z');
  const view = await h.momentService.today({ ...couple, timezone: 'Asia/Ho_Chi_Minh' }, String(uid));
  assert.equal(view.sessions.length, 1); assert.equal(JSON.stringify(h.day), before); assert.equal(h.calls.ensure.length, 0);
  assert.equal(view.scheduleVersion, 3); assert.equal(view.sessions[0].rewardEndsAt, '2026-11-15T09:30:00.000Z');
  assert.equal(view.sessions[0].closesAt, '2026-11-16T00:00:00.000Z');
  h.setClock('2026-11-15T09:30:00Z');
  const pulse = await h.momentService.pulse(couple, String(uid));
  assert.equal(pulse.state, 'open'); assert.equal(pulse.sessionId, h.target().sessionId);
  assert.equal(pulse.rewardEndsAt, view.sessions[0].rewardEndsAt); assert.equal(pulse.closesAt, view.sessions[0].closesAt);
});
test('target, before-open and foreign key guards; HEAD crossing reward cutoff accepts a late post', async () => {
  const h = harness();
  await rejectsCode(h.momentService.createUploadUrl(couple, String(uid), {}, 'image/jpeg', 10), 'MOMENT_SESSION_REQUIRED');
  await rejectsCode(h.momentService.post(couple, String(uid), { ...h.input(), sessionId: 'wrong' }), 'NOT_FOUND');
  h.setClock('2026-11-15T08:59:59.999Z');
  await rejectsCode(h.momentService.post(couple, String(uid), h.input()), 'MOMENT_NOT_YET');
  h.setClock('2026-11-15T09:00:00Z');
  for (const key of [h.input().key.replace(String(uid), String(partner)), h.input().key.replace('/s1/', '/s2/')]) {
    await rejectsCode(h.momentService.post(couple, String(uid), { ...h.input(), key }), 'FORBIDDEN');
  }
  const upload = await h.momentService.createUploadUrl(couple, String(uid), h.target(), 'image/jpeg', 10);
  assert.ok(upload.imageKey.startsWith(`couples/${cid}/moments/2026-11-15/s1/${uid}/`));
  h.setClock('2026-11-15T09:29:59.999Z');
  h.storage.headObject = async () => { h.setClock('2026-11-15T09:30:00Z'); return { size: 1 }; };
  const view = await h.momentService.post(couple, String(uid), h.input());
  assert.equal(view.sessions[0].mine.postedAt, '2026-11-15T09:30:00.000Z'); assert.equal(view.sessions[0].mine.lateMin, 1);
  assert.equal(view.sessions[0].closed, false); assert.equal(h.calls.notification.length, 0);
  assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 0);
  assert.equal(h.calls.post[0][3].postedAt, undefined); assert.equal(h.calls.post[0][3].lateMin, undefined);
});
test('capture honors saved midnight after timezone edit changes the current local date', async () => {
  const h = harness(); h.setClock('2026-11-15T23:00Z');
  const changed = { ...couple, timezone: 'Asia/Ho_Chi_Minh' };
  assert.equal(dates.getLocalDate(new Date('2026-11-15T23:00Z'), changed.timezone), '2026-11-16');
  const view = await h.momentService.post(changed, String(uid), h.input());
  assert.equal(view.localDate, '2026-11-15'); assert.equal(view.sessions[0].closesAt, '2026-11-16T00:00:00.000Z');
  assert.equal(h.calls.ensure.length, 0);
});
test('reward cutoff does not expire presign; midnight does expire presign and HEAD, stale day never falls forward', async () => {
  const h = harness();
  h.storage.getUploadUrl = async () => { h.setClock('2026-11-15T09:30:00Z'); return { uploadUrl: 'mock', expiresIn: 1 }; };
  await h.momentService.createUploadUrl(couple, String(uid), h.target(), 'image/jpeg', 1);
  h.storage.getUploadUrl = async () => { h.setClock('2026-11-16T00:00:00Z'); return { uploadUrl: 'mock', expiresIn: 1 }; };
  await rejectsCode(h.momentService.createUploadUrl(couple, String(uid), h.target(), 'image/jpeg', 1), 'MOMENT_CLOSED');
  h.setClock('2026-11-15T23:59:59.999Z');
  h.storage.headObject = async () => { h.setClock('2026-11-16T00:00:00Z'); return { size: 1 }; };
  await rejectsCode(h.momentService.post(couple, String(uid), h.input()), 'MOMENT_CLOSED');
  assert.equal(h.calls.post.length, 0); assert.equal(h.calls.quest.length, 0); assert.equal(h.calls.ensure.length, 0);
});
test('database timestamp, not request clock, controls lateness and midnight rejection', async () => {
  const h = harness(); h.setClock('2026-11-15T09:29:50Z'); h.setDbClock('2026-11-15T09:30:00.001Z');
  const view = await h.momentService.post(couple, String(uid), h.input());
  assert.equal(view.sessions[0].mine.postedAt, '2026-11-15T09:30:00.001Z');
  assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 0); assert.equal(h.calls.notification.length, 0);
  const late = harness(); late.setClock('2026-11-15T23:59:50Z'); late.setDbClock('2026-11-16T00:00:00Z');
  await rejectsCode(late.momentService.post(couple, String(uid), late.input()), 'MOMENT_CLOSED');
  assert.equal(late.calls.quest.length, 0); assert.equal(late.calls.notification.length, 0);
});
test('one daily photo/member, same-day unlock and late pair gets neutral completion notification', async () => {
  const h = harness();
  await h.momentService.post(couple, String(uid), h.input());
  assert.equal(h.calls.notification[0][2].push.expiresAt, '2026-11-15T09:30:00.000Z');
  assert.equal(h.calls.notification[0][2].type, 'moment_posted');
  assert.equal(h.calls.notification[0][2].eventKey, `${h.day._id}:s1:${uid}`);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.notification[0][2].target)), { kind:'moment', dayId:String(h.day._id), localDate:'2026-11-15', sessionId:'s1' });
  await rejectsCode(h.momentService.post(couple, String(uid), h.input()), 'MOMENT_ALREADY_POSTED');
  const hidden = await h.momentService.today(couple, String(partner));
  assert.equal(hidden.sessions[0].partner.photo, null);
  h.setClock('2026-11-15T23:59:59.999Z');
  const both = await h.momentService.post(couple, String(partner), { ...h.input(), key: h.input().key.replace(String(uid), String(partner)) });
  assert.equal(both.sessions[0].state, 'both'); assert.ok(both.sessions[0].partner.photo);
  assert.equal(h.calls.notification[1][2].type, 'moment_both'); assert.equal(h.calls.notification[1][2].push.expiresAt, undefined);
  assert.ok(!h.calls.notification[1][2].push.body('Partner').includes('40'));
  assert.equal(model.momentProgress(h.day, couple.memberIds), 2); assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 1);
});
test('legacy and v2 read-only with original times/IDs/photos/Story; future legacy time remains hidden', async () => {
  const h = harness();
  h.day = { _id: h.day._id, localDate: '2026-11-15', promptAt: new Date('2026-11-15T09:00Z'), posts: [{ userId: uid, key: 'old', width: 1, height: 1, postedAt: new Date(), caption: 'old caption', lateMin: 40 }], storyId: new Types.ObjectId() };
  const v = await h.momentService.today(couple, String(uid));
  assert.equal(v.legacy, true); assert.equal(v.scheduleVersion, 1); assert.equal(v.sessions[0].closed, true);
  assert.equal(v.sessions[0].mine.lateMin, 40); assert.ok(v.sessions[0].storyId);
  assert.equal(v.sessions[0].rewardEndsAt, '2026-11-15T09:10:00.000Z');
  for (const action of [() => h.momentService.post(couple, String(uid), { localDate: h.day.localDate, sessionId: 'legacy' }), () => h.momentService.toStory(couple, String(uid), { localDate: h.day.localDate, sessionId: 'legacy' })]) await rejectsCode(action(), 'MOMENT_LEGACY_READ_ONLY');
  h.setClock('2026-11-15T08:00Z'); assert.equal((await h.momentService.today(couple, String(uid))).sessions.length, 0);
  const old = harness(); old.day.scheduleVersion = 2;
  old.day.sessions = ['09:00', '13:00', '17:00'].map((time, index) => ({ ...old.day.sessions[0], id: `old-${index}`, promptAt: new Date(`2026-11-15T${time}Z`), closesAt: new Date(+new Date(`2026-11-15T${time}Z`) + 600000), rewardEndsAt: undefined }));
  const before = JSON.stringify(old.day); old.setClock('2026-11-15T09:01Z');
  const oldView = await old.momentService.today(couple, String(uid));
  assert.equal(oldView.legacy, false); assert.equal(oldView.scheduleVersion, 2); assert.equal(oldView.sessions.length, 1);
  assert.equal(oldView.sessions[0].closed, true); assert.equal(oldView.sessions[0].state, 'missed');
  assert.equal(oldView.sessions[0].rewardEndsAt, '2026-11-15T09:10:00.000Z');
  assert.equal((await old.momentService.pulse(couple, String(uid))).sessionId, null);
  for (const action of [() => old.momentService.post(couple, String(uid), old.input()), () => old.momentService.createUploadUrl(couple, String(uid), old.target(), 'image/jpeg', 1), () => old.momentService.toStory(couple, String(uid), old.target())]) await rejectsCode(action(), 'MOMENT_LEGACY_READ_ONLY');
  assert.equal(JSON.stringify(old.day), before); assert.equal(old.calls.ensure.length, 0);
  old.setClock('2026-11-15T21:00Z'); assert.equal((await old.momentService.today(couple, String(uid))).sessions.length, 3);
});
test('reward uses strict timestamps/distinct members, preserves old policy, streak ignores lateness', () => {
  const post = (userId, postedAt = new Date('2026-11-15T09:29:59.999Z')) => ({ userId, postedAt, lateMin: 0 });
  const h = harness(), s = h.day.sessions[0];
  s.posts = [post(uid), post(partner)]; assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 2);
  s.posts[1].postedAt = s.rewardEndsAt; assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 1);
  s.posts[0].postedAt = new Date(+s.promptAt - 1); assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 0);
  s.posts = [post(uid), post(uid), post(new Types.ObjectId())]; assert.equal(model.momentRewardProgress(h.day, couple.memberIds), 1);
  const split = { scheduleVersion: 3, sessions: [{ ...s, posts: [post(uid)] }, { ...s, posts: [post(partner)] }] };
  assert.equal(model.momentRewardProgress(split, couple.memberIds), 1);
  assert.equal(model.momentProgress(split, couple.memberIds), 1);
  for (const old of [{ scheduleVersion: 2, sessions: [{ posts: [post(uid), post(partner, new Date('2026-11-15T23:00Z'))] }] }, { posts: [post(uid), post(partner)] }]) {
    assert.equal(model.momentRewardProgress(old, couple.memberIds), 2); assert.equal(model.momentProgress(old, couple.memberIds), 2);
  }
  assert.equal(model.momentRewardProgress(null, couple.memberIds), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.streakOf(['2026-11-15','2026-11-15','2026-11-14','2026-11-12'], '2026-11-15'))), { current: 2, best: 2 });
  assert.equal(h.streakOf(['2026-11-14','2026-11-13'], '2026-11-16').current, 0);
});
test('Story CAS shares objects, preserves completed late pair and cleans losing Story', async () => {
  const h = harness();
  h.day.sessions[0].posts = [uid, partner].map(userId => ({ userId, key: `old/${userId}`, width: 1, height: 1, caption: '', postedAt: new Date('2026-11-15T23:00Z'), lateMin: 810 }));
  await h.momentService.toStory(couple, String(uid), h.target());
  assert.equal(h.calls.stories[0][3].sharedPhotos[0], 'moments');
  await rejectsCode(h.momentService.toStory(couple, String(uid), h.target()), 'MOMENT_STORY_EXISTS');
  h.day.sessions[0].storyId = null; h.failCas();
  await rejectsCode(h.momentService.toStory(couple, String(uid), h.target()), 'MOMENT_STORY_EXISTS');
  assert.equal(h.calls.deletes.length, 1); assert.equal(h.day.sessions[0].posts.length, 2);
});
test('repository writes postedAt/lateMin from same DB NOW with literal metadata and atomic session/member bounds', async () => {
  let captured, duplicate = false;
  const winner = { sessions: ['winner'] };
  const query = result => ({ exec: async () => result });
  const modelMock = { findOneAndUpdate: (...args) => { captured = args; return { exec: async () => { if (duplicate) throw {code:11000}; return winner; } }; }, findOne: () => query(winner) };
  const {momentRepository: repo} = load('repositories/moment.repository.ts', { mongoose: { Types }, '../models/DuoMoment.js': { DuoMoment: modelMock, MOMENT_SCHEDULE_VERSION: 3 } });
  await repo.addPost(cid, '2026-11-15', '$s1', { userId: uid, key: '$key', width: 1, height: 1, caption: '$$NOW' });
  const [filter, update] = captured;
  assert.equal(filter.scheduleVersion, 3); assert.equal(filter.coupleId, cid); assert.equal(filter.sessions.$elemMatch.id, '$s1');
  assert.equal(filter.sessions.$elemMatch['posts.userId'].$ne, uid);
  const conditions = filter.$expr.$anyElementTrue[0].$map.in.$and;
  assert.ok(conditions.some(c => c.$gt?.[0] === '$$s.closesAt' && c.$gt[1] === '$$NOW'));
  assert.ok(conditions.some(c => c.$lte?.[0] === '$$s.promptAt' && c.$lte[1] === '$$NOW'));
  assert.equal(conditions[0].$eq[1].$literal, '$s1');
  const append = update[0].$set.sessions.$map.in.$cond;
  assert.equal(append[0].$eq[1].$literal, '$s1');
  const fields = append[1].$mergeObjects[1].posts.$concatArrays[1][0].$mergeObjects;
  assert.equal(fields[0].$literal.caption, '$$NOW'); assert.equal(fields[0].$literal.key, '$key');
  assert.equal(fields[1].postedAt, '$$NOW');
  const late = fields[1].lateMin.$cond;
  assert.equal(late[0].$lt[0], '$$NOW'); assert.equal(late[0].$lt[1], '$$s.rewardEndsAt'); assert.equal(late[1], 0);
  assert.equal(late[2].$max[0], 1); assert.equal(late[2].$max[1].$ceil.$divide[0].$subtract[0], '$$NOW');
  assert.equal(late[2].$max[1].$ceil.$divide[0].$subtract[1], '$$s.rewardEndsAt');
  await repo.markNotified(cid, 's1');
  assert.equal(captured[0].scheduleVersion, 3);
  assert.ok(captured[0].$expr.$anyElementTrue[0].$map.in.$and.some(c => c.$gt?.[0] === '$$s.rewardEndsAt' && c.$gt[1] === '$$NOW'));
  assert.equal(captured[1].$currentDate['sessions.$.notifiedAt'], true);
  await repo.setStory(cid, cid, 's1', null, uid); assert.equal(captured[0].scheduleVersion, 3);
  duplicate = true; assert.equal(await repo.ensureDay({ coupleId: cid, localDate: '2026-11-15', sessions: ['candidate'] }), winner);
  assert.equal(captured[1].$setOnInsert.sessions[0], 'candidate');
});
test('repository due scan excludes v2 and reward-expired sessions even while capture stays open', async () => {
  let filter;
  const now = new Date('2026-11-15T09:30Z');
  const rows = [{ _id: cid, sessions: [{ id: 'expired', promptAt: new Date('2026-11-15T09:00Z'), rewardEndsAt: now, closesAt: new Date('2026-11-16T00:00Z'), notifiedAt: null },
    { id: 'timely', promptAt: now, rewardEndsAt: new Date('2026-11-15T10:00Z'), closesAt: new Date('2026-11-16T00:00Z'), notifiedAt: null }] }];
  const query = { select() { return this; }, limit() { return this; }, lean() { return this; }, exec: async () => rows };
  const { momentRepository: repo } = load('repositories/moment.repository.ts', { mongoose: { Types }, '../models/DuoMoment.js': { MOMENT_SCHEDULE_VERSION: 3, DuoMoment: { find(f) { filter = f; return query; } } } });
  const due = await repo.listDueToNotify(['2026-11-15'], now, 10);
  assert.equal(filter.scheduleVersion, 3); assert.equal(filter.sessions.$elemMatch.rewardEndsAt.$gt, now);
  assert.equal(due.length, 1); assert.equal(due[0].sessionId, 'timely');
});
test('scheduler sends only CAS winner, uses reward expiry and skips delayed invitations after cutoff', async () => {
  const h = harness(); const calls = []; let claimed = false;
  const repo = { existingDays: async () => new Set(), createDays: async () => 0,
    listDueToNotify: async () => [{id:h.day._id,sessionId:'s1'}], markNotified: async () => { if(claimed) return null; claimed=true; return h.day; } };
  const {duoMomentPromptJob: job, PROMPT_BODY} = load('services/jobs/duoMomentPrompt.job.ts', {
    '../realtimeAudience.service.js': { realtimeAudience: { couple: async () => {} } },
    '../../repositories/couple.repository.js': { coupleRepository: { listActivePage: async () => [], findById: async () => couple } },
    '../../repositories/moment.repository.js': { momentRepository: repo }, '../../utils/date.js': dates,
    '../../utils/logger.js': {logger:{debug(){},warn(){}}}, '../moment.service.js': {newMomentDay:h.newMomentDay},
    '../notification.service.js': {notificationService:{emit:async input=>calls.push(input)}},
  }, { Date: h.Clock });
  await Promise.all([job.run(new Date('2026-11-15T09:08Z')),job.run(new Date('2026-11-15T09:08Z'))]);
  assert.equal(calls.length,2); assert.equal(calls[0].push.expiresAt,'2026-11-15T09:30:00.000Z');
  assert.equal(calls[0].coupleId,cid); assert.equal(calls[0].eventKey,`${h.day._id}:s1`);
  assert.deepEqual(calls.map(c=>String(c.to)).sort(),[String(uid),String(partner)].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].target)),{kind:'moment',dayId:String(h.day._id),localDate:'2026-11-15',sessionId:'s1'});
  assert.ok(calls[0].push.url.includes('session=s1')); assert.ok(PROMPT_BODY.includes('40 Xu')); assert.ok(!PROMPT_BODY.includes('30 phút'));
  claimed = false; h.setClock('2026-11-15T09:30Z'); await job.run(new Date('2026-11-15T09:29Z')); assert.equal(calls.length, 2);
});
