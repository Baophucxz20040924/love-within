'use strict';
// Explicit opt-in only: node backend/tests/couple-notifications/mongo.cjs --run-local-mongo
// Fixed permitted local DB, UUID-tagged own synthetic rows only; no dropDatabase, .env or providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const mongoose = require('mongoose');
function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const mod={exports:{}};
  vm.runInNewContext(code,{module:mod,exports:mod.exports,Date,Buffer,require(name){assert.ok(Object.hasOwn(mocks,name),`Unmocked ${name}`);return mocks[name];}},{filename});
  return mod.exports;
}
async function run() {
  if (!process.argv.includes('--run-local-mongo')) { console.log('SKIP local Mongo inbox integration: pass --run-local-mongo explicitly.'); return; }
  const tag=crypto.randomUUID();
  const oid=()=>new mongoose.Types.ObjectId(), uid=oid(), partner=oid(), cid=oid(), newCid=oid();
  let models, snapshots;
  await mongoose.connect('mongodb://127.0.0.1:27017/lookwithin_dev',{serverSelectionTimeoutMS:3000});
  try {
    const rules=load('config/notificationTypes.ts');
    models=load('models/CoupleNotification.ts',{mongoose,'../config/notificationTypes.js':rules});
    snapshots=load('models/CoupleNotificationSnapshot.ts',{mongoose});
    await Promise.all([models.CoupleNotification.init(),snapshots.CoupleNotificationSnapshot.init()]);
    const {coupleNotificationRepository:repo}=load('repositories/coupleNotification.repository.ts',{
      mongoose,'node:crypto':crypto,'../models/CoupleNotification.js':models,'../models/CoupleNotificationSnapshot.js':snapshots,
    });
    let user={_id:uid,coupleId:cid},couple={_id:cid,status:'active',memberIds:[uid,partner]};
    const hints=[];
    const {coupleNotificationsService:service}=load('services/coupleNotifications.service.ts',{
      mongoose,'../repositories/coupleNotification.repository.js':{coupleNotificationRepository:repo},
      '../repositories/user.repository.js':{userRepository:{findById:async()=>user}},
      '../repositories/couple.repository.js':{coupleRepository:{findActiveById:async id=>couple?.status==='active'&&couple._id.equals(id)?couple:null}},
      '../utils/errors.js':load('utils/errors.ts'),'./realtimeAudience.service.js':{realtimeAudience:{own:async(...args)=>hints.push(args)}},
    });
    const scope={userId:uid,coupleId:cid};
    const input={...scope,type:'couple_comment',actorId:partner,entityId:oid(),eventKey:`${tag}:comment:one`,target:{kind:'story',id:String(oid())}};
    const attempts=await Promise.all(Array.from({length:20},()=>repo.addOnce(input)));
    assert.equal(attempts.filter(Boolean).length,1,'real unique upsert concurrency must insert exactly one row');
    const row=await models.CoupleNotification.findOne(scope).exec();
    const originalCreatedAt=+row.createdAt;
    const page=await service.list(String(uid));
    assert.equal(page.items.length,1);
    // Deliberately make the later insertion look older than the observed page's timestamp.
    await repo.addOnce({...input,eventKey:'comment:later'});
    await models.CoupleNotification.updateOne({...scope,eventKey:'comment:later'},{$set:{createdAt:new Date(originalCreatedAt-1)}});
    await service.seen(String(uid),[page.watermark]);
    await service.readAll(String(uid),[page.watermark]);
    await repo.addOnce(input);
    const again=await models.CoupleNotification.findById(row._id).exec();
    assert.equal(+again.createdAt,originalCreatedAt);assert.ok(again.readAt);assert.ok(again.seenAt);
    const later=await models.CoupleNotification.findOne({...scope,eventKey:'comment:later'}).exec();
    assert.equal(later.readAt,null);assert.equal(later.seenAt,null);
    assert.equal((await service.unread(String(uid))).notifications,1);
    const count=hints.length;await service.seen(String(uid),[page.watermark]);assert.equal(hints.length,count);
    await repo.addOnce({...input,userId:partner,eventKey:'foreign'});
    const foreign=await models.CoupleNotification.findOne({userId:partner}).exec();
    await assert.rejects(service.read(String(uid),String(foreign._id)),e=>e.code==='NOT_FOUND');
    const foreignToken=await repo.observe({userId:partner,coupleId:cid},[foreign._id]);
    await assert.rejects(service.seen(String(uid),[foreignToken]),e=>e.code==='BAD_REQUEST');
    await assert.rejects(service.readAll(String(uid),[foreignToken]),e=>e.code==='BAD_REQUEST');
    const actions=[()=>service.list(String(uid)),()=>service.unread(String(uid)),()=>service.seen(String(uid),[page.watermark]),()=>service.readAll(String(uid),[page.watermark]),()=>service.read(String(uid),String(row._id))];
    couple.status='archived';for(const action of actions) await assert.rejects(action(),e=>e.code==='NO_COUPLE');
    couple.status='active';couple.memberIds=[partner];for(const action of actions) await assert.rejects(action(),e=>e.code==='NO_COUPLE');
    user={_id:uid,coupleId:newCid};couple={_id:newCid,status:'active',memberIds:[uid,partner]};
    assert.equal((await service.list(String(uid))).items.length,0);
    await assert.rejects(service.seen(String(uid),[page.watermark]),e=>e.code==='BAD_REQUEST');
    await assert.rejects(service.readAll(String(uid),[page.watermark]),e=>e.code==='BAD_REQUEST');
    await assert.rejects(service.read(String(uid),String(row._id)),e=>e.code==='NOT_FOUND');
    const indexes=await models.CoupleNotification.collection.indexes();
    assert.ok(indexes.some(i=>i.unique&&i.key.userId===1&&i.key.coupleId===1&&i.key.eventKey===1));
    assert.ok(indexes.some(i=>i.key.createdAt===1&&i.expireAfterSeconds===90*86400));
    const snapshotIndexes=await snapshots.CoupleNotificationSnapshot.collection.indexes();
    assert.ok(snapshotIndexes.some(i=>i.key.expiresAt===1&&i.expireAfterSeconds===0));
    console.log('PASS local Mongo: concurrent unique insert, durable read/seen, exact observed IDs, scoped ACL, retention indexes. TTL monitor expiry timing is not asserted.');
  } finally {
    // Delete only this run's fresh synthetic recipient+couple IDs; leave all real collections/data intact.
    const own={userId:{$in:[uid,partner]},coupleId:{$in:[cid,newCid]}};
    try {
      if(models) await models.CoupleNotification.deleteMany(own);
      if(snapshots) await snapshots.CoupleNotificationSnapshot.deleteMany(own);
    } finally { await mongoose.disconnect(); }
  }
}
run().catch(err=>{console.error(err);process.exitCode=1;});
