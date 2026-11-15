'use strict';
// Never imported by unit tests. Explicit local-only opt-in; isolated collection, no dotenv/server/providers.
if (process.argv.length !== 3 || process.argv[2] !== '--local-lookwithin-dev') throw new Error('Explicit --local-lookwithin-dev opt-in required');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const mongoose = require('mongoose');
const namespace = require('../personal-wallets/namespace.cjs').install(mongoose);
const models = require('../../dist/models/DuoMoment.js');
const {DuoMoment} = models;
const {momentRepository: repo} = require('../../dist/repositories/moment.repository.js');
const URI = namespace.URI;
const coupleId = new mongoose.Types.ObjectId();
const members = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
const post = (userId, key = `fixture/${randomUUID()}`) => ({userId, key, width:10, height:10, caption:'$$NOW'});
async function run() {
  await mongoose.connect(URI, {serverSelectionTimeoutMS:3000, autoIndex:false});
  assert.equal(mongoose.connection.name, 'lookwithin_dev');
  await namespace.prepare();
  const {localTime:dbNow} = await mongoose.connection.db.admin().command({hello:1});
  const session = () => ({id:randomUUID(), promptAt:new Date(+dbNow-60000), rewardEndsAt:new Date(+dbNow+1740000), closesAt:new Date(+dbNow+3600000), notifiedAt:null, posts:[], storyId:null});
  const candidate = localDate => ({coupleId, localDate, timezone:'UTC', scheduleVersion:3, sessions:[session()]});
  const candidates = Array.from({length:8}, () => candidate('2090-11-15'));
  const days = await Promise.all(candidates.map(d => repo.ensureDay(d)));
  const winner = days[0], date = winner.localDate, sid = winner.sessions[0].id;
  assert.equal(await DuoMoment.countDocuments({coupleId, localDate:date}), 1);
  assert.ok(days.every(d => String(d._id) === String(winner._id) && d.sessions.length === 1 && d.sessions[0].id === sid));
  const claims = await Promise.all(Array.from({length:8}, () => repo.markNotified(winner._id, sid)));
  assert.equal(claims.filter(Boolean).length, 1, 'one prompt claim per day');
  const posts = await Promise.all(Array.from({length:8}, () => repo.addPost(coupleId, date, sid, {...post(members[0], '$literal-key'), postedAt:new Date(0), lateMin:999})));
  assert.equal(posts.filter(Boolean).length, 1, 'concurrent same-member posts have one winner');
  const partnerPosts = await Promise.all(Array.from({length:4}, () => repo.addPost(coupleId, date, sid, post(members[1]))));
  assert.equal(partnerPosts.filter(Boolean).length, 1);
  let current = await repo.findDay(coupleId, date);
  assert.equal(current.sessions[0].posts.length, 2);
  const saved = current.sessions[0].posts[0];
  assert.ok(saved.postedAt >= dbNow); assert.equal(saved.lateMin, 0);
  assert.equal(saved.key, '$literal-key'); assert.equal(saved.caption, '$$NOW');
  assert.equal(models.momentRewardProgress(current, members), 2);
  assert.equal(await repo.addPost(coupleId, date, 'wrong-session', post(members[0])), null);
  assert.equal(await repo.addPost(new mongoose.Types.ObjectId(), date, sid, post(members[0])), null);
  const storyIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const stories = await Promise.all(storyIds.map(id => repo.setStory(coupleId, winner._id, sid, null, id)));
  assert.equal(stories.filter(Boolean).length, 1);

  const late = await repo.ensureDay(candidate('2090-11-16'));
  const lateSid = late.sessions[0].id;
  // Advance the saved reward boundary using DB time, without sleeping or trusting the application clock.
  await DuoMoment.updateOne({_id:late._id}, [{$set:{sessions:{$map:{input:'$sessions', as:'s', in:{$mergeObjects:['$$s', {promptAt:{$subtract:['$$NOW',1800000]}, rewardEndsAt:'$$NOW'}]}}}}}]);
  assert.equal(await repo.markNotified(late._id, lateSid), null, 'no invitation after reward deadline despite open capture');
  const due = await repo.listDueToNotify([date, late.localDate], new Date(), 20);
  assert.ok(!due.some(row => String(row.id) === String(late._id)));
  for (const member of members) assert.ok(await repo.addPost(coupleId, late.localDate, lateSid, {...post(member), postedAt:new Date(0), lateMin:0}));
  const lateDay = await repo.findDay(coupleId, late.localDate);
  const lateSession = lateDay.sessions[0];
  for (const photo of lateSession.posts) {
    assert.ok(photo.postedAt >= lateSession.rewardEndsAt);
    assert.equal(photo.lateMin, Math.max(1, Math.ceil((photo.postedAt - lateSession.rewardEndsAt) / 60000)), 'lateMin uses the exact saved DB timestamp');
  }
  assert.equal(models.momentProgress(lateDay, members), 2);
  assert.equal(models.momentRewardProgress(lateDay, members), 0);
  assert.deepEqual(await repo.bothDays(coupleId, 10), [late.localDate, date], 'late pairs keep their daily streak');

  const closed = await repo.ensureDay(candidate('2090-11-17'));
  await DuoMoment.updateOne({_id:closed._id}, [{$set:{sessions:{$map:{input:'$sessions', as:'s', in:{$mergeObjects:['$$s', {closesAt:'$$NOW'}]}}}}}]);
  assert.equal(await repo.addPost(coupleId, closed.localDate, closed.sessions[0].id, {...post(members[0]), postedAt:new Date(+dbNow-1000)}), null);
  assert.equal(await repo.markNotified(closed._id, closed.sessions[0].id), null);
  const future = candidate('2090-11-18');
  future.sessions[0].promptAt = new Date(+dbNow+1800000);
  const unopened = await repo.ensureDay(future);
  assert.equal(await repo.addPost(coupleId, unopened.localDate, unopened.sessions[0].id, post(members[0])), null);
  assert.equal(await repo.markNotified(unopened._id, unopened.sessions[0].id), null);

  // Existing days are not migrated, overwritten or reopened by the new scheduler.
  const legacy = await DuoMoment.create({coupleId, localDate:'2090-11-19', promptAt:dbNow, posts:[]});
  const oldSession = {...session(), rewardEndsAt:undefined};
  const v2 = await DuoMoment.create({coupleId, localDate:'2090-11-20', scheduleVersion:2, timezone:'UTC', sessions:[oldSession, {...session(), rewardEndsAt:undefined}, {...session(), rewardEndsAt:undefined}]});
  const untouched = await repo.ensureDay(candidate(legacy.localDate)); assert.equal(untouched.sessions, undefined);
  const untouchedV2 = await repo.ensureDay(candidate(v2.localDate)); assert.equal(untouchedV2.scheduleVersion, 2); assert.equal(untouchedV2.sessions.length, 3);
  assert.equal(await repo.addPost(coupleId, v2.localDate, oldSession.id, post(members[0])), null);
  assert.equal(await repo.markNotified(v2._id, oldSession.id), null);
  assert.equal(await repo.setStory(coupleId, v2._id, oldSession.id, null, new mongoose.Types.ObjectId()), null);
  console.log('PASS local Mongo v3 moments: schedule/CAS, DB timestamp+literal pipeline, reward/capture boundaries, late streak, old history');
}
run().catch(error => {console.error(error); process.exitCode=1;}).finally(async () => {
  if (mongoose.connection.readyState === 1) await namespace.cleanup();
  await mongoose.disconnect();
});
