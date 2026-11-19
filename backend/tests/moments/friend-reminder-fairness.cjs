'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),{Types}=require('mongoose');
const id=n=>new Types.ObjectId(n.toString(16).padStart(24,'0'));
const now=new Date('2026-11-18T00:00:00Z');
const event=n=>({_id:id(n+10),creatorId:id(1),inviteeIds:[id(2),id(3)],rsvps:{[id(2)]:'going',[id(3)]:'no'},startAt:new Date(now.getTime()+3600000)});
function load(file,mocks){const filename=path.resolve(__dirname,'../../src',file),module={exports:{}};const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,Promise,Map,Set,require(name){assert.ok(Object.hasOwn(mocks,name),`Unexpected import ${name}`);return mocks[name];}},{filename});return module.exports;}
function harness(){let rows=Array.from({length:501},(_,n)=>event(n)),blocked=false,friends=[id(2),id(3)],queries=[],done=new Set(rows.slice(0,500).map(e=>`bb-event:${e._id}:${e.startAt.toISOString()}:h2`)),notifications=[],claims=[],fail=null,hold;
 const job=load('services/jobs/friendEventsRemind.job.ts',{
 mongoose:{Types},'../../repositories/friendEvent.repository.js':{friendEventRepository:{listStartingBetween:async(from,to,limit,after)=>{queries.push({from,to,limit,after});if(hold)await hold;if(fail==='list')throw Error('list');return rows.filter(e=>e.status!=='cancelled'&&!e.deletedAt&&e.startAt>from&&e.startAt<=to&&(!after||e.startAt>after.startAt||+e.startAt===+after.startAt&&String(e._id)>String(after.id))).sort((a,b)=>+a.startAt-+b.startAt||String(a._id).localeCompare(String(b._id))).slice(0,limit);}}},
 '../../repositories/friendship.repository.js':{friendshipRepository:{friendIds:async()=>friends}},'../../repositories/friendSafety.repository.js':{friendBlockRepository:{isBlockedBetween:async()=>blocked}},'../../utils/logger.js':{logger:{warn(){},debug(){}}},'../notification.service.js':{notificationService:{emit:async data=>notifications.push(data)}},'../scheduler.service.js':{alreadySent:async keys=>{if(fail==='done')throw Error('done');return new Set(keys.filter(k=>done.has(k)));},claimSend:async key=>{if(fail===key)throw Error('claim');claims.push(key);if(done.has(key))return false;done.add(key);return true;}},
 }).friendEventsRemindJob;
 return{job,queries,notifications,claims,done,set rows(v){rows=v;},set fail(v){fail=v;},set blocked(v){blocked=v;},set friends(v){friends=v;},pause(){let release;hold=new Promise(r=>release=r);return()=>{hold=null;release();};}};}
(async()=>{
 let h=harness();assert.equal(await h.job.run(now),0);assert.equal(h.queries[0].limit,500);assert.equal(await h.job.run(now),1);assert.equal(h.notifications.length,2);assert.equal(String(h.queries[1].after.id),String(id(509)));await h.job.run(now);assert.equal(h.queries[2].after,undefined,'short tail resets for next invocation');
 h=harness();h.fail='done';await assert.rejects(h.job.run(now),/done/);h.fail=null;await h.job.run(now);assert.equal(h.queries[1].after,undefined,'failed done read cannot advance');
 h=harness();h.rows=[event(0),event(1),event(2)];h.done.clear();const key=`bb-event:${id(11)}:${event(1).startAt.toISOString()}:h2`;h.fail=key;await assert.rejects(h.job.run(now),/claim/);h.fail=null;await h.job.run(now);assert.equal(String(h.queries[1].after.id),String(id(10)),'only completed earlier record checkpoints');assert.equal(h.notifications.length,6);
 h=harness();const release=h.pause();const a=h.job.run(now),b=h.job.run(now);assert.equal(a,b,'single-flight for direct and scheduled entry');release();await Promise.all([a,b]);assert.equal(h.queries.length,1);
 h=harness();await h.job.run(now);h.rows=[];await h.job.run(now);await h.job.run(now);assert.equal(h.queries[2].after,undefined,'empty resets');
 // Current eligibility and startAt-specific claims remain independent of scan position.
 for (const mode of ['hidden','blocked','unfriended','maybe']) {
  h=harness();const e=event(0);e.rsvps[String(id(2))]=mode==='maybe'?'maybe':'going';if(mode==='hidden')e.hiddenByReportsAt=now;
  h.rows=[e];h.done.clear();if(mode==='blocked')h.blocked=true;if(mode==='unfriended')h.friends=[];
  assert.equal(await h.job.run(now),1);assert.equal(h.notifications.length,mode==='maybe'?2:1,mode);
 }
 h=harness();const moved=event(0);h.rows=[moved];h.done.clear();await h.job.run(now);moved.startAt=new Date(+moved.startAt+60000);await h.job.run(now);assert.equal(h.claims.length,2);assert.notEqual(h.claims[0],h.claims[1],'reschedule re-arms startAt claim');
 h=harness();h.done.clear();h.rows=[{...event(0),status:'cancelled'},{...event(1),deletedAt:now},{...event(2),startAt:now},{...event(3),startAt:new Date(+now+7200001)}];assert.equal(await h.job.run(now),0);assert.equal(h.claims.length,0,'cancelled/deleted/expired/outside window do not claim');
 let filter,sort,limit;
 const chain={sort(s){sort=s;return this;},limit(n){limit=n;return this;},select(){return this;},lean(){return this;},exec:async()=>[]};
 const repo=load('repositories/friendEvent.repository.ts',{'../utils/commentPage.js':{commentPageFilter(){assert.fail('Comment paging is outside reminder query test');}},mongoose:{Types},'../models/FriendEvent.js':{FriendEvent:{find(f){filter=f;return chain;}}}}).friendEventRepository;
 await repo.listStartingBetween(now,new Date(+now+7200000),500,{startAt:event(0).startAt,id:id(10)});
 assert.equal(filter.deletedAt,null);assert.equal(filter.status,'active');assert.equal(filter.startAt.$gt,now);assert.equal(filter.$or[1]._id.$gt.toString(),String(id(10)));assert.equal(sort._id,1);assert.equal(sort.startAt,1);assert.equal(limit,500);
 console.log('PASS Friends reminder: 501st fairness, tie cursor, failed-read/partial checkpoints, tail reset, single-flight and live-window seek');
})().catch(e=>{console.error(e);process.exitCode=1;});
