'use strict';
const assert = require('node:assert/strict');
const {loader,quiet,mongoose}=require('./harness.cjs');
const {Types}=mongoose;
const query = fn => ({exec:async()=>fn()});
let persisted=null, writes=0;
const Couple={findOneAndUpdate:(_filter,update)=>query(()=>{writes++;if(persisted)return null;persisted={...update.$set.dailyRewardPolicy};return {dailyRewardPolicy:persisted};}),
  findById:()=>query(()=>({dailyRewardPolicy:persisted}))};
const {rewardPolicyService:service,newDailyRewardPolicy}=loader({...quiet,'models/Couple.ts':{Couple}})('services/rewardPolicy.service.ts');
const {addDays,getLocalDate}=loader()('utils/date.ts');
const a=new Types.ObjectId(),b=new Types.ObjectId();
(async()=>{
 const c={_id:new Types.ObjectId(),memberIds:[a,b],timezone:'Pacific/Kiritimati'};
 const [first,second]=await Promise.all([service.ensure({...c}),service.ensure({...c})]);
 assert.equal(first.effectiveDate,second.effectiveDate);assert.equal(first.effectiveDate,addDays(getLocalDate(new Date(),c.timezone),1));
 assert.equal(first.timezone,c.timezone);const date=first.effectiveDate;
 c.timezone='America/Los_Angeles';assert.equal((await service.ensure(c)).effectiveDate,date,'cutover cannot slide on later requests/timezone');
 assert.equal((await service.forDay(c,addDays(date,-1))).version,1);assert.equal((await service.forDay(c,date)).version,2);
 const before=writes;await service.ensure(c);assert.equal(writes,before,'document cached policy avoids new proposal');
 const immediate=newDailyRewardPolicy('Asia/Ho_Chi_Minh',new Date('2026-01-01T17:00:00Z'));assert.equal(immediate.effectiveDate,'2026-01-02');
 assert.equal(newDailyRewardPolicy('Asia/Ho_Chi_Minh',new Date('2026-01-01T16:59:59Z')).effectiveDate,'2026-01-01');
 console.log('PASS policy: durable create-once next-day cutover, concurrency, frozen timezone, immediate atomic new-couple policy and midnight');
})().catch(e=>{console.error(e);process.exitCode=1;});
