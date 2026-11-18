'use strict';
const assert=require('node:assert/strict');
const {loader,mongoose}=require('./harness.cjs');
const {Types}=mongoose;
let stored=null,serverNow;
const clone=x=>JSON.parse(JSON.stringify(x));
const checkinModel={findOneAndUpdate:(filter,pipeline,options)=>({orFail(){return this;},exec:async()=>{
 assert.equal(filter.sourceValid,false,'only inert rows may be replaced');assert.equal(options.upsert,true);assert.equal(options.timestamps,false);
 const set=pipeline[0].$set;assert.deepEqual(clone(set.sourceValid),{$and:[{$gte:['$$NOW',opens.toISOString()]},{$lt:['$$NOW',closes.toISOString()]}]});
 assert.equal(set.rewardIntent.$cond[2],null,'invalid commit has no reward intent');assert.equal(set.createdAt,'$$NOW');
 if(stored?.sourceValid){const error=Error('duplicate');error.code=11000;throw error;}
 const valid=serverNow>=opens&&serverNow<closes;
 stored={...Object.fromEntries(Object.entries(set).filter(([,v])=>v&&v.$literal!==undefined).map(([k,v])=>[k,v.$literal])),
  sourceValid:valid,dailySettlementPending:valid,rewardIntent:valid?set.rewardIntent.$cond[1].$literal:null};return stored;
}})};
const repo=loader({'models/Checkin.ts':{Checkin:checkinModel}})('repositories/checkin.repository.ts').checkinRepository;
const opens=new Date('2026-01-01T00:00:00Z'),closes=new Date('2026-01-02T00:00:00Z');
const input={coupleId:new Types.ObjectId(),userId:new Types.ObjectId(),localDate:'2026-01-01',streak:1,coinAwarded:0,expAwarded:5,dailySettlementPending:true,
 dayOpensAt:opens,dayClosesAt:closes,rewardIntent:{operationId:'checkin:fixture',actorUserId:'actor',ownerUserId:'actor',coin:0,exp:5}};
(async()=>{
 serverNow=new Date(+opens-1);await repo.create(input);assert.equal(stored.sourceValid,false);assert.equal(stored.rewardIntent,null);
 serverNow=opens;await repo.create(input);assert.equal(stored.sourceValid,true);assert.equal(stored.rewardIntent,input.rewardIntent,'retry can replace inert row when valid');
 await assert.rejects(repo.create(input),e=>e.code===11000,'valid source is immutable');
 stored=null;serverNow=closes;await repo.create(input);assert.equal(stored.sourceValid,false);assert.equal(stored.dailySettlementPending,false,'late predecessor cannot enter settlement');
 console.log('PASS checkin source fence: Mongo $$NOW boundaries, retryable inert source and valid-source uniqueness');
})().catch(e=>{console.error(e);process.exitCode=1;});
