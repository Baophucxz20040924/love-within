'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const ts = require('typescript');
const {Types} = require('mongoose');
function load(relative, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const mod = {exports:{}};
  vm.runInNewContext(code,{module:mod,exports:mod.exports,Date,Buffer,Error,...globals,require(name){assert.ok(Object.hasOwn(mocks,name),name);return mocks[name];}},{filename});
  return mod.exports;
}
function deferred() { let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve}; }
const tick=()=>new Promise(r=>setImmediate(r));
function harness() {
  let now=Date.parse('2026-11-15T09:00:00Z');
  class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));}static now(){return now;} }
  const calls=[];
  const provider={enabled:true,send:async(sub,payload,opts)=>{calls.push({sub,payload:JSON.parse(payload),opts});return {status:'ok'};}};
  let lookup=async()=>Array.from({length:6},()=>({_id:new Types.ObjectId(),endpoint:'https://fcm.googleapis.com/mock',keys:{}}));
  const settings={couple:{preview:true,moments:true},friends:{preview:true},quiet:{enabled:false,from:'23:00',to:'07:00'}};
  const {pushService,pushTtl}=load('services/push.service.ts',{
    mongoose:{Types},'../config/notificationTypes.js':{COUPLE_PUSH_GROUPS:['moments'],FRIENDS_PUSH_GROUPS:[]},
    '../integrations/index.js':{getPush:()=>provider},'../models/User.js':{DEFAULT_PUSH_SETTINGS:settings},
    '../repositories/pushSubscription.repository.js':{pushSubscriptionRepository:{listFor:(...a)=>lookup(...a),markSuccess:async()=>{},deleteById:async()=>{},incFail:async()=>0}},
    '../repositories/user.repository.js':{userRepository:{findPushProfile:async()=>({pushSettings:settings,timezone:'UTC'}),findDisplayNames:async()=>new Map()}},
    '../utils/date.js':{getLocalTime:()=> '09:00'},'../utils/errors.js':{AppError:Error},'../utils/logger.js':{logger:{debug(){},warn(){},info(){}}},
  },{Date:Clock});
  const job=(expiry)=>({userId:new Types.ObjectId(),space:'couple',group:'moments',type:'moment_prompt',actorId:null,content:{body:'capture',url:'/moments?session=test',tag:'moment:test',expiresAt:expiry},timed:true});
  const drain=async()=>{for(let i=0;i<100&&pushService.pendingCount();i++)await tick();assert.equal(pushService.pendingCount(),0);};
  return {pushService,pushTtl,calls,provider,job,drain,setNow:v=>now=+new Date(v),setLookup:fn=>lookup=fn,settings};
}
test('expiry TTL exact cutoff, fractional second and ordinary TTL unchanged',()=>{
  const h=harness(),now=Date.parse('2026-11-15T09:00Z');
  assert.equal(h.pushTtl(undefined,14400,now),14400);
  assert.equal(h.pushTtl('2026-11-15T09:30Z',14400,now),1800);
  assert.equal(h.pushTtl('2026-11-15T09:00:00.999Z',14400,now),0);
  assert.equal(h.pushTtl('2026-11-15T09:00Z',14400,now),null);
  assert.equal(h.pushTtl('bad',14400,now),null);
});
test('expiry after device lookup suppresses every device, even preview-hidden notifications',async()=>{
  const h=harness();h.settings.couple.preview=false;
  h.setLookup(async()=>{h.setNow('2026-11-15T09:30Z');return [{_id:new Types.ObjectId(),endpoint:'mock',keys:{}}];});
  h.pushService.enqueue(h.job('2026-11-15T09:30Z'));await h.drain();assert.equal(h.calls.length,0);
});
test('expiry rechecked before each batch; hidden payload still carries expiry for service worker',async()=>{
  const h=harness();h.settings.couple.preview=false;
  h.provider.send=async(sub,payload,opts)=>{h.calls.push({payload:JSON.parse(payload),opts});if(h.calls.length===5)h.setNow('2026-11-15T09:30Z');return {status:'ok'};};
  h.pushService.enqueue(h.job('2026-11-15T09:30Z'));await h.drain();assert.equal(h.calls.length,5);
  assert.equal(h.calls[0].opts.ttlSec,1800);assert.equal(h.calls[0].payload.expiresAt,'2026-11-15T09:30Z');
  assert.equal(h.calls[0].payload.body,'Bạn có thông báo mới');assert.equal(h.calls[0].payload.tag,'moment:test');
});
test('backlogged invitation expires before dequeue; other notification TTL remains four hours',async()=>{
  const h=harness(),gate=deferred();let lookups=0;
  h.setLookup(async()=>{lookups++;await gate.promise;return [{_id:new Types.ObjectId(),endpoint:'mock',keys:{}}];});
  for(let i=0;i<10;i++)h.pushService.enqueue(h.job(undefined));
  h.pushService.enqueue(h.job('2026-11-15T09:30Z'));
  assert.equal(lookups,10);h.setNow('2026-11-15T09:30Z');gate.resolve();await h.drain();
  assert.equal(lookups,10);assert.equal(h.calls.length,10);assert.equal(h.calls[0].opts.ttlSec,14400);
});
test('notification service forwards optional expiry unmodified',async()=>{
  const calls=[];
  const {notificationService}=load('services/notification.service.ts',{
    mongoose:{Types},'../config/notificationTypes.js':{COUPLE_PUSH_RULES:{moment_prompt:{group:'moments',timed:true}},FRIENDS_PUSH_RULES:{}},
    '../models/FriendNotification.js':{GROUPED_NOTIFICATION_TYPES:new Set(),OUTING_NOTIFICATION_TYPES:new Set(),SYSTEM_NOTIFICATION_TYPES:new Set()},
    '../repositories/friendNotification.repository.js':{friendNotificationRepository:{}},'../repositories/friendSafety.repository.js':{friendBlockRepository:{}},
    '../utils/logger.js':{logger:{warn(){}}},'./push.service.js':{pushService:{enqueue:job=>calls.push(job)}},
    './realtimeAudience.service.js':{realtimeAudience:{own:async()=>{}}},
  });
  const push={body:'capture',url:'/moments',expiresAt:'2026-11-15T09:30Z'};
  await notificationService.emit({space:'couple',to:new Types.ObjectId(),actorId:null,type:'moment_prompt',push});
  assert.equal(calls[0].content,push);assert.equal(calls[0].content.expiresAt,push.expiresAt);
});
test('service worker drops delayed/invalid capture pushes, retains ordinary notifications',async()=>{
  const handlers={},shown=[];
  const code=fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/sw.js'),'utf8');
  class Clock extends Date {static now(){return Date.parse('2026-11-15T09:30Z');}}
  vm.runInNewContext(code,{Date:Clock,URL,Promise,Number,self:{addEventListener:(name,fn)=>handlers[name]=fn,location:{origin:'https://mock.invalid'},registration:{showNotification:async(...a)=>shown.push(a)},navigator:{}}});
  const send=async expiresAt=>{let promise;handlers.push({data:{json:()=>({title:'test',body:'capture',url:'/moments',expiresAt})},waitUntil:p=>promise=p});await promise;};
  for(const expiry of ['2026-11-15T09:30Z','2026-11-15T09:29Z','bad',null])await send(expiry);
  assert.equal(shown.length,0);await send('2026-11-15T09:30:01Z');await send(undefined);assert.equal(shown.length,2);
});
