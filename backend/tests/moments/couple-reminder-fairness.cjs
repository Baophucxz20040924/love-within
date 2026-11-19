'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),mongoose=require('mongoose');
const id=n=>new mongoose.Types.ObjectId(n.toString(16).padStart(24,'0'));
const now=new Date('2026-11-19T09:30:00Z');
function harness(population,events){
 const state={couples:population,events,claims:new Set(),sent:[],scans:[],autos:0,fail:null,gate:null};
 const load=(file,mocks)=>{const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,require:n=>{assert.ok(Object.hasOwn(mocks,n),`Unmocked ${n}`);return mocks[n];}},{filename:file});return module.exports;};
 const date=load('utils/date.ts',{});
 const job=load('services/jobs/coupleEventsRemind.job.ts',{
  'mongoose':mongoose,'../../utils/date.js':date,'../../utils/logger.js':{logger:{debug(){}}},
  '../../repositories/couple.repository.js':{coupleRepository:{listActivePage:async(after,limit)=>state.couples.filter(c=>!after||String(c._id)>String(after)).slice(0,limit),findActiveById:async cid=>state.couples.find(c=>String(c._id)===String(cid))??null}},
  '../../repositories/event.repository.js':{eventRepository:{listRemindablePage:async(cid,from,to,limit,after)=>{state.scans.push({cid,from,to,limit,after});if(state.gate)await state.gate;if(state.fail==='query')throw Error('query');return state.events.filter(e=>String(e.coupleId)===String(cid)&&(!after||String(e._id)>String(after))).slice(0,limit+1);}}},
  '../event.service.js':{autoMilestones:()=>{state.autos++;return[];}},
  '../scheduler.service.js':{alreadySent:async keys=>{if(state.fail==='done')throw Error('done');return new Set(keys.filter(k=>state.claims.has(k)));},claimSend:async key=>{if(state.fail===key)throw Error('claim');if(state.claims.has(key))return false;state.claims.add(key);return true;}},
  '../realtimeAudience.service.js':{realtimeAudience:{couple:async()=>{}}},
  '../notification.service.js':{notificationService:{emit:async n=>state.sent.push(n)}},
 });return{state,...job};
}
const couple=n=>({_id:id(n),memberIds:[id(90000),id(90001)],timezone:'UTC'});
const event=(n,cid,date='2026-11-19',time=null,repeat='none')=>({_id:id(n),coupleId:cid,title:'Fixture',emoji:'',date,time,repeat});
(async()=>{
 const c=couple(1),events=Array.from({length:5001},(_,i)=>event(i+100,c._id));const h=harness([c],events);
 for(let i=0;i<10;i++){await h.coupleEventsRemindJob.run(now);assert.equal(h.state.claims.size,(i+1)*500);}
 assert.equal(h.state.autos,1);await h.coupleEventsRemindJob.run(now);assert.equal(h.state.claims.size,5001);assert.equal(h.state.autos,1);
 assert.ok(h.state.scans.every(s=>s.limit<=500));await h.coupleEventsRemindJob.run(now);assert.equal(h.state.autos,2);
 const pop=Array.from({length:51},(_,i)=>couple(i+1)),outer=harness(pop,[]);await outer.coupleEventsRemindJob.run(now);assert.equal(outer.state.scans.length,50);await outer.coupleEventsRemindJob.run(now);assert.equal(outer.state.scans.length,51);
 const failure=harness([c],events.slice(0,3));failure.state.fail='done';await assert.rejects(failure.coupleEventsRemindJob.run(now));assert.equal(failure.state.claims.size,0);failure.state.fail=null;await failure.coupleEventsRemindJob.run(now);assert.equal(failure.state.claims.size,3);
 const partial=harness([c],events.slice(0,3));partial.state.fail=`cp-event:${events[1]._id}:2026-11-19:d0`;await assert.rejects(partial.coupleEventsRemindJob.run(now));assert.equal(partial.state.claims.size,1);partial.state.fail=null;await partial.coupleEventsRemindJob.run(now);assert.equal(partial.state.scans[1].after.toString(),events[0]._id.toString());assert.equal(partial.state.claims.size,3);
 const concurrent=harness([c],events.slice(0,1));let release;concurrent.state.gate=new Promise(r=>release=r);const a=concurrent.coupleEventsRemindJob.run(now),b=concurrent.coupleEventsRemindJob.run(now);assert.equal(a,b);release();await a;assert.equal(concurrent.state.claims.size,1);
 const clock=harness([c],events);await clock.coupleEventsRemindJob.run(new Date('2026-11-19T07:50:00Z'));assert.equal(clock.state.autos,0);await clock.coupleEventsRemindJob.run(now);assert.equal(clock.state.autos,1);await clock.coupleEventsRemindJob.run(new Date('2026-11-20T09:30:00Z'));assert.equal(clock.state.autos,2);assert.equal(clock.state.scans.at(-1).from,'2026-11-19');
 c.timezone='Asia/Ho_Chi_Minh';await clock.coupleEventsRemindJob.run(new Date('2026-11-20T09:40:00Z'));assert.equal(clock.state.autos,3);c.timezone='UTC';
 const archived=harness([c],events);await archived.coupleEventsRemindJob.run(now);archived.state.couples=[];await archived.coupleEventsRemindJob.run(now);assert.equal(archived.state.scans.length,1);
 const queryFailure=harness([c],events.slice(0,2));queryFailure.state.fail='query';await assert.rejects(queryFailure.coupleEventsRemindJob.run(now));queryFailure.state.fail=null;await queryFailure.coupleEventsRemindJob.run(now);assert.equal(queryFailure.state.scans[1].after,undefined);assert.equal(queryFailure.state.claims.size,2);
 const slots=harness([c],[]);const due=slots.dueReminders(c,[event(1,c._id,'2026-11-26'),event(2,c._id,'2026-11-20'),event(3,c._id,'2026-11-19'),event(4,c._id,'2026-11-19','10:00'),event(5,c._id,'2000-11-19',null,'yearly')],now);
 assert.deepEqual(Array.from(due,r=>r.slot),['d7','d1','d0','h1','d0']);
 let filter,sort,projection,limit;
 const chain={sort(v){sort=v;return this;},select(v){projection=v;return this;},limit(v){limit=v;return this;},lean(){return this;},exec:async()=>[]};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../src/repositories/event.repository.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:n=>{if(n==='mongoose')return mongoose;assert.equal(n,'../models/CoupleEvent.js');return{CoupleEvent:{find:f=>{filter=f;return chain;}}};}});
 await module.exports.eventRepository.listRemindablePage(c._id,'2026-11-18','2026-11-28',500,id(200));
 assert.equal(String(filter.coupleId),String(c._id));assert.equal(filter.deletedAt,null);assert.equal(filter.remind,true);assert.equal(String(filter._id.$gt),String(id(200)));assert.equal(filter.$or[0].repeat,'yearly');assert.equal(filter.$or[1].date.$gte,'2026-11-18');assert.equal(filter.$or[1].date.$lte,'2026-11-28');assert.equal(sort._id,1);assert.equal(limit,501);assert.equal(projection,'coupleId title emoji date time repeat');
 console.log('PASS couple reminder: 5001-event inner continuation, 51-couple outer budget, auto once, failed reads/partial progress, single-flight and slot parity');
})().catch(e=>{console.error(e);process.exitCode=1;});
