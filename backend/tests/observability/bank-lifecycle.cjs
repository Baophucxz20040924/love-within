'use strict';
// Actual lifecycle and shutdown source; fake timers and all persistence/provider/process boundaries.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file,mocks,globals={}){const filename=path.resolve(__dirname,'../../src',file),module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Promise,Date,Math,Error,...globals,require(name){assert.ok(Object.hasOwn(mocks,name),`Unexpected import ${name}`);return mocks[name];}},{filename});return module.exports;}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function harness(){const timers=new Map();let seq=0,lists=0,syncs=0,connections=[{},{}],listWait=null,syncWait=null;
 function timer(fn,ms,interval=false){const t={id:++seq,fn,ms,interval,unref(){}};timers.set(t.id,t);return t;}
 const api=load('services/bankSync.service.ts',{
 '../config/env.js':{env:{bank:{pollIntervalSec:60,provider:'mock'}}},'../integrations/index.js':{getBankFeed:()=>({})},'../integrations/bank/BankFeedProvider.js':{BankFeedError:class extends Error{}},
 '../repositories/bankConnection.repository.js':{bankConnectionRepository:{listActive:async()=>{lists++;if(listWait)await listWait.promise;return connections;}}},'../repositories/bankTransaction.repository.js':{},'../repositories/user.repository.js':{},'../utils/crypto.js':{assertSecretKey(){}},'../utils/date.js':{},'../utils/logger.js':{logger:{info(){},error(){}}},'./financeRealtime.service.js':{},
 },{process:{env:{}},setTimeout:(fn,ms)=>timer(fn,ms),clearTimeout:t=>timers.delete(t.id),setInterval:(fn,ms)=>timer(fn,ms,true),clearInterval:t=>timers.delete(t.id)});
 api.bankSyncService.syncConnection=async()=>{syncs++;if(syncWait)await syncWait.promise;};
 async function fire(ms){const t=[...timers.values()].find(t=>t.ms===ms);assert.ok(t,`timer ${ms}`);if(!t.interval)timers.delete(t.id);t.fn();await tick();}
 return{...api,timers,fire,get lists(){return lists;},get syncs(){return syncs;},holdList(){return listWait=deferred();},holdSync(){return syncWait=deferred();},setConnections:v=>connections=v};}
(async()=>{
 let h=harness();h.startBankSync();h.startBankSync();assert.equal(h.timers.size,2);await h.stopBankSync();assert.equal(h.timers.size,0);assert.equal(h.lists,0);
 h=harness();let wait=h.holdList();h.startBankSync();await h.fire(10000);const stopped=h.stopBankSync();wait.resolve();await stopped;assert.equal(h.syncs,0);assert.equal(h.timers.size,0);
 h=harness();wait=h.holdSync();h.startBankSync();await h.fire(10000);assert.equal(h.syncs,1);const stop=h.stopBankSync();h.startBankSync();await h.fire(10000);assert.equal(h.lists,1,'old active cycle still owns overlap guard');wait.resolve();await stop;assert.equal(h.syncs,1,'no next connection after stop');await h.stopBankSync();assert.equal(h.timers.size,0);
 h=harness();h.startBankSync();await h.fire(10000);assert.equal(h.syncs,1);assert.ok([...h.timers.values()].some(t=>t.ms<3000));await h.stopBankSync();assert.equal(h.syncs,1);assert.equal(h.timers.size,0,'jitter interrupted');
 h=harness();wait=h.holdSync();h.startBankSync();await h.fire(10000);const timeout=h.stopBankSync();await h.fire(10000);await timeout;h.startBankSync();await h.fire(10000);assert.equal(h.lists,1,'join timeout never releases true overlap ownership');wait.resolve();await tick();await h.stopBankSync();
 const events=[],handlers={},bank=deferred(),scheduler=deferred(),push=deferred();let close;
 load('server.ts',{'./app.js':{createApp:()=>({listen:()=>({close:fn=>{events.push('close');close=fn;}})})},'./config/env.js':{env:{}},'./db/connection.js':{connectDb:async()=>{},syncIndexes:async()=>{},disconnectDb:async()=>events.push('disconnect')},'./services/quest.service.js':{questService:{seedDefaults:async()=>{}}},'./utils/monitor.js':{startResourceMonitor(){},stopResourceMonitor:()=>events.push('monitor')},'./services/bankSync.service.js':{startBankSync(){},stopBankSync:()=>{events.push('bank');return bank.promise;}},'./services/scheduler.service.js':{startScheduler(){},stopScheduler:()=>{events.push('scheduler');return scheduler.promise;}},'./services/push.service.js':{drainPush:()=>{events.push('push');return push.promise;}},'./utils/logger.js':{logger:{info(){},error(){}}},'./services/realtime.service.js':{assertSingleRealtimeProcess(){},realtimeService:{drain:()=>events.push('drain')}}},{process:{on:(name,fn)=>handlers[name]=fn,exit:code=>events.push(`exit:${code}`)}});
 await tick();handlers.SIGINT();handlers.SIGTERM();assert.equal(events.filter(e=>e==='bank').length,1);close();bank.resolve();await tick();assert.ok(!events.includes('disconnect'));scheduler.resolve();await tick();assert.equal(events.at(-1),'push');assert.ok(!events.includes('disconnect'));push.resolve();await tick();assert.deepEqual(events.slice(-2),['disconnect','exit:0']);
 console.log('PASS bank lifecycle: tracked startup, idempotence, stop during list/sync/jitter, restart fencing, bounded join overlap and single shutdown');
})().catch(e=>{console.error(e);process.exitCode=1;});
