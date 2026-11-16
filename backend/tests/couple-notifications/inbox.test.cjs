'use strict';
// Isolated service/repository tests: no .env, database, network or push provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const ts = require('typescript');
const mongoose = require('mongoose');
const { Types } = mongoose;
function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Buffer, console,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked ${name}`); return mocks[name]; } }, { filename });
  return mod.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const errors = load('utils/errors.ts');
const rules = load('config/notificationTypes.ts');
const uid = new Types.ObjectId(), partner = new Types.ObjectId(), cid = new Types.ObjectId(), otherCid = new Types.ObjectId();
const scope = { userId: uid, coupleId: cid };
const equals = (a,b) => a == null || b == null ? a === b : String(a) === String(b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(v => matches(row,v));
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Types.ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([op,v]) => op === '$in' ? v.some(x => equals(actual,x)) : op === '$lt' ? actual < v : op === '$gt' ? actual > v : false);
    }
    return equals(actual,value);
  });
}
function harness() {
  const rows = [], snapshots = [], calls = [], hints = [];
  let user = { _id: uid, coupleId: cid }, couple = { _id: cid, status: 'active', memberIds: [uid, partner] };
  let duplicate = false, fail = false;
  function query(source, filter) {
    let sort = null, limit = Infinity;
    const q = { sort(s) { sort=s; return q; }, limit(n) { limit=n; return q; }, select() { return q; }, lean() { return q; }, async exec() {
      let result = source.filter(r=>matches(r,filter));
      if (sort) result = result.sort((a,b)=>{for(const [key,dir] of Object.entries(sort)) { if(a[key]<b[key]) return -dir; if(a[key]>b[key]) return dir; } return 0;});
      return result.slice(0,limit);
    } }; return q;
  }
  function update(source, filter, patch, options = {}, many = false) { return { async exec() {
    calls.push({ filter, patch, options });
    if (fail) throw Error('database unavailable');
    if (duplicate && options.upsert) throw Object.assign(Error('duplicate'), { code:11000 });
    const found = source.filter(r=>matches(r,filter));
    if (!found.length && options.upsert) {
      source.push({ _id:new Types.ObjectId(), ...patch.$setOnInsert, ...patch.$set });
      return { upsertedCount:1, matchedCount:0, modifiedCount:0 };
    }
    const changed = many ? found : found.slice(0,1);
    changed.forEach(r=>Object.assign(r,patch.$set));
    return { upsertedCount:0, matchedCount:changed.length, modifiedCount:changed.length };
  } }; }
  const model = { find: f=>query(rows,f), exists: async f=>rows.find(r=>matches(r,f)) ?? null,
    updateOne: (...a)=>update(rows,...a), updateMany: (f,u)=>update(rows,f,u,{},true) };
  const snapshotModel = { find:f=>query(snapshots,f), updateOne:(...a)=>update(snapshots,...a) };
  const { coupleNotificationRepository: repo } = load('repositories/coupleNotification.repository.ts', {
    'node:crypto': crypto, mongoose:{Types}, '../models/CoupleNotification.js':{CoupleNotification:model},
    '../models/CoupleNotificationSnapshot.js':{CoupleNotificationSnapshot:snapshotModel},
  });
  const { coupleNotificationsService: service } = load('services/coupleNotifications.service.ts', {
    mongoose:{Types}, '../repositories/coupleNotification.repository.js':{coupleNotificationRepository:repo},
    '../repositories/user.repository.js':{userRepository:{findById:async()=>user}},
    '../repositories/couple.repository.js':{coupleRepository:{findActiveById:async id=>couple?.status==='active'&&equals(couple._id,id)?couple:null}},
    '../utils/errors.js':errors, './realtimeAudience.service.js':{realtimeAudience:{own:async(...args)=>hints.push(args)}},
  });
  async function insert(key, overrides={}) {
    await repo.addOnce({ ...scope, type:'couple_comment',actorId:partner,entityId:partner,eventKey:`comment:${key}`,target:{kind:'story',id:String(partner)},...overrides });
    return rows.at(-1);
  }
  return {repo,service,rows,snapshots,calls,hints,insert,model,
    setUser:u=>user=u,setCouple:c=>couple=c,setDuplicate:v=>duplicate=v,setFail:v=>fail=v};
}

test('schema has recipient/couple/event unique index, stable cursor and retention; strips private target fields', () => {
  let schema;
  const {CoupleNotification} = load('models/CoupleNotification.ts',{
    mongoose:{...mongoose,model:(_name,s)=>{schema=s;return mongoose.model('UnitCoupleNotification',s);}},'../config/notificationTypes.js':rules,
  });
  const indexes=schema.indexes();
  assert.ok(indexes.some(([keys,opts])=>opts.unique && keys.userId===1&&keys.coupleId===1&&keys.eventKey===1));
  assert.ok(indexes.some(([keys])=>keys.createdAt===-1&&keys._id===-1));
  assert.ok(indexes.some(([,opts])=>opts.expireAfterSeconds===90*86400));
  const doc=new CoupleNotification({...scope,type:'moment_prompt',eventKey:'prompt',target:{kind:'moment',dayId:String(uid),localDate:'2026-11-15',sessionId:'session',caption:'secret',photo:'signed'},createdAt:new Date()});
  assert.equal(doc.validateSync(),undefined);
  assert.equal(doc.toObject().target.caption,undefined);assert.equal(doc.toObject().target.photo,undefined);
});

test('insert-only idempotency, concurrent dedupe, separate comments/lifecycle identities and failures', async () => {
  const h=harness();
  await Promise.all(Array.from({length:10},()=>h.insert('one')));
  assert.equal(h.rows.length,1);
  assert.deepEqual(Object.keys(h.calls[0].patch),['$setOnInsert']);
  const row=h.rows[0], created=row.createdAt;row.readAt=new Date(123);row.seenAt=new Date(456);
  await h.insert('one');assert.equal(row.createdAt,created);assert.equal(+row.readAt,123);assert.equal(+row.seenAt,456);
  await h.insert('two');assert.equal(h.rows.length,2,'separate comments on one story must not group');
  await h.insert('two',{userId:partner});await h.insert('two',{coupleId:otherCid});assert.equal(h.rows.length,4);
  h.setDuplicate(true);assert.equal(await h.repo.addOnce({...scope,eventKey:'racing'}),false);
  h.setDuplicate(false);h.setFail(true);await assert.rejects(h.insert('fail'),/database/);
});

test('pagination sorts timestamp ties by id, scopes every page and excludes lookahead from observed snapshot', async () => {
  const h=harness();
  for(let i=1;i<=43;i++) { const row=await h.insert(i);row._id=new Types.ObjectId(i.toString(16).padStart(24,'0'));row.createdAt=new Date(1000); }
  await h.insert('foreign',{userId:partner});await h.insert('old',{coupleId:otherCid});
  const first=await h.service.list(String(uid));assert.equal(first.items.length,20);assert.ok(first.nextCursor);assert.equal(first.items[0].id,'00000000000000000000002b');
  const snapshot=h.snapshots.find(s=>s.token===first.watermark);assert.equal(snapshot.notificationIds.length,20);
  const second=await h.service.list(String(uid),first.nextCursor);const third=await h.service.list(String(uid),second.nextCursor);
  const all=[...first.items,...second.items,...third.items];assert.equal(all.length,43);assert.equal(new Set(all.map(r=>r.id)).size,43);assert.equal(third.nextCursor,null);
  assert.equal((await h.service.list(String(uid))).watermark,first.watermark,'same page identity is stable');
  await assert.rejects(h.service.list(String(uid),'bad'),e=>e.code==='BAD_REQUEST');
  assert.deepEqual(Object.keys(first.items[0]).sort(),['actorId','createdAt','entityId','id','read','target','type'].sort());
});

test('server-observed pages only: later same-time/backdated arrivals and lookahead cannot be seen or read', async () => {
  const h=harness();for(let i=0;i<21;i++) await h.insert(i);
  const page=await h.service.list(String(uid));const observed=new Set(h.snapshots[0].notificationIds.map(String));
  const later=await h.insert('late');later.createdAt=new Date(1);
  const count=await h.service.unread(String(uid));assert.equal(count.notifications,22);
  await h.service.seen(String(uid),[page.watermark]);assert.equal(h.rows.filter(r=>r.seenAt).length,20);assert.equal(h.rows.filter(r=>r.readAt).length,0);
  assert.equal((await h.service.unread(String(uid))).notifications,2);
  assert.deepEqual(plain(h.hints[0]),[String(uid),'couple',['couple-notification-unread']]);
  await h.service.seen(String(uid),[page.watermark]);assert.equal(h.hints.length,1,'no-op ack must not invalidate');
  await h.service.readAll(String(uid),[page.watermark]);assert.equal(h.rows.filter(r=>r.readAt).length,20);
  for(const row of h.rows) if(!observed.has(String(row._id))) {assert.equal(row.readAt,null);assert.equal(row.seenAt,null);}
  assert.deepEqual(plain(h.hints[1]),[String(uid),'couple',['couple-notifications']]);
  await h.service.readAll(String(uid),[page.watermark,page.watermark]);assert.equal(h.hints.length,2);
  h.snapshots[0].expiresAt=new Date(0);await assert.rejects(h.service.seen(String(uid),[page.watermark]),e=>e.code==='BAD_REQUEST');
});

test('all endpoint services reject stale/current-nonmember/archived couples and foreign row/snapshot',async()=>{
  const h=harness();const own=await h.insert('own');await h.insert('other',{userId:partner});
  const page=await h.service.list(String(uid));const foreign=h.rows.at(-1);
  await assert.rejects(h.service.read(String(uid),String(foreign._id)),e=>e.code==='NOT_FOUND');
  const foreignToken=await h.repo.observe({userId:partner,coupleId:cid},[foreign._id]);
  await assert.rejects(h.service.seen(String(uid),[foreignToken]),e=>e.code==='BAD_REQUEST');
  await assert.rejects(h.service.readAll(String(uid),[foreignToken]),e=>e.code==='BAD_REQUEST');
  await h.service.read(String(uid),String(own._id));assert.equal(own.seenAt,null,'read does not dismiss badge');
  const actions=[()=>h.service.list(String(uid)),()=>h.service.unread(String(uid)),()=>h.service.seen(String(uid),[page.watermark]),()=>h.service.readAll(String(uid),[page.watermark]),()=>h.service.read(String(uid),String(own._id))];
  for(const candidate of [null,{_id:cid,status:'archived',memberIds:[uid,partner]},{_id:cid,status:'active',memberIds:[partner]}]) {
    h.setCouple(candidate);for(const action of actions) await assert.rejects(action(),e=>e.code==='NO_COUPLE');
  }
  h.setCouple({_id:otherCid,status:'active',memberIds:[uid,partner]});h.setUser({_id:uid,coupleId:otherCid});
  assert.equal((await h.service.list(String(uid))).items.length,0);assert.equal((await h.service.unread(String(uid))).notifications,0);
  await assert.rejects(h.service.read(String(uid),String(own._id)),e=>e.code==='NOT_FOUND');
  await assert.rejects(h.service.seen(String(uid),[page.watermark]),e=>e.code==='BAD_REQUEST');
  h.setUser(null);for(const action of actions) await assert.rejects(action(),e=>e.code==='UNAUTHORIZED');
});

test('empty pages, bounded badge, and invalid acknowledgement batch validation',async()=>{
  const h=harness();const empty=await h.service.list(String(uid));assert.equal(empty.items.length,0);assert.equal(empty.nextCursor,null);
  await h.service.seen(String(uid),[empty.watermark]);await h.service.readAll(String(uid),[empty.watermark]);assert.equal(h.hints.length,0);
  for(let i=0;i<101;i++) await h.insert(i);
  assert.deepEqual(plain(await h.service.unread(String(uid))),{notifications:99,notificationsSaturated:true});
  for(const tokens of [[],['fake'],Array(26).fill(empty.watermark)]) await assert.rejects(h.service.seen(String(uid),tokens),e=>e.code==='BAD_REQUEST');
});

test('all18 event types persist without device/preferences access; duplicates do not push, ACL and failure are best effort',async()=>{
  const stored=[], jobs=[], hints=[], keys=new Set();let currentCouple=cid,active=true,fail=false;
  const {notificationService:svc}=load('services/notification.service.ts',{
    mongoose:{Types},'../config/notificationTypes.js':rules,
    '../models/FriendNotification.js':{GROUPED_NOTIFICATION_TYPES:new Set(),OUTING_NOTIFICATION_TYPES:new Set(),SYSTEM_NOTIFICATION_TYPES:new Set()},
    '../repositories/friendNotification.repository.js':{friendNotificationRepository:{}},'../repositories/friendSafety.repository.js':{friendBlockRepository:{}},
    '../repositories/coupleNotification.repository.js':{coupleNotificationRepository:{addOnce:async input=>{
      if(fail) throw Error('offline'); const key=`${input.userId}:${input.coupleId}:${input.eventKey}`;
      if(keys.has(key))return false; keys.add(key);stored.push(input);return true;
    }}},
    '../repositories/couple.repository.js':{coupleRepository:{findActiveById:async id=>active&&equals(id,cid)?{_id:cid,memberIds:[uid,partner]}:null}},
    '../repositories/user.repository.js':{userRepository:{findById:async()=>({coupleId:currentCouple,pushSettings:{couple:{moments:false},quiet:{enabled:true}}})}},
    '../utils/logger.js':{logger:{warn(){}}},'./push.service.js':{pushService:{enqueue:input=>jobs.push(input)}},
    './realtimeAudience.service.js':{realtimeAudience:{}},'./coupleNotifications.service.js':{invalidateCoupleNotifications:async id=>hints.push(id)},
  });
  const input={space:'couple',coupleId:cid,to:uid,actorId:partner,entityId:partner,eventKey:'source:occurrence',target:{kind:'story',id:String(partner)},push:{body:()=>{throw Error('private callback never evaluated');},url:'/private'}};
  for(const type of rules.COUPLE_NOTIFICATION_TYPES) await svc.emit({...input,type});
  assert.equal(stored.length,18);assert.equal(jobs.length,18);assert.equal(hints.length,18);
  assert.ok(stored.every(row=>row.push===undefined&&row.body===undefined));
  await svc.emit({...input,type:'moment_prompt'});assert.equal(jobs.length,18);
  await svc.emit({...input,to:partner,type:'nudge'});assert.equal(stored.length,18,'no self delivery');
  currentCouple=otherCid;await svc.emit({...input,type:'nudge',eventKey:'new'});assert.equal(stored.length,18,'old event never follows recipient into new couple');
  currentCouple=cid;active=false;await svc.emit({...input,type:'nudge',eventKey:'new'});assert.equal(stored.length,18);
  active=true;fail=true;await assert.doesNotReject(svc.emit({...input,type:'nudge',eventKey:'new'}));assert.equal(jobs.length,18);
  await assert.doesNotReject(svc.toPartner({_id:cid,memberIds:[uid,partner]},'invalid',{type:'nudge'}));
});
