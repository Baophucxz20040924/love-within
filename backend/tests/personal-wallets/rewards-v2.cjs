'use strict';
const assert=require('node:assert/strict');
const {loader,quiet,mongoose}=require('./harness.cjs');
const {Types}=mongoose;const a=new Types.ObjectId(),b=new Types.ObjectId();
const couple={_id:new Types.ObjectId(),memberIds:[a,b],timezone:'America/Los_Angeles',dailyRewardPolicy:{version:2,effectiveDate:'2020-01-01',timezone:'Asia/Ho_Chi_Minh'}};
const policy={ensure:async c=>c.dailyRewardPolicy,forDay:async c=>c.dailyRewardPolicy};
const query=fn=>({exec:async()=>fn()});let checkin=null,progress=null,inputs=[];
const walletService={reward:async input=>{inputs.push(input);return {coin:0,exp:5,level:1};}};
const common={...quiet,'services/rewardPolicy.service.ts':{rewardPolicyService:policy},'services/wallet.service.ts':{walletService}};
const checkinRepository={findByDate:async()=>checkin,findLatest:async()=>null,findForCoupleDate:async()=>checkin?[checkin]:[],
 create:async input=>checkin={...input,_id:new Types.ObjectId(),sourceValid:true}};
const checkinService=loader({...common,'repositories/checkin.repository.ts':{checkinRepository},'models/Checkin.ts':{Checkin:{updateOne:()=>query(()=>{})}},
 'services/quest.service.ts':{questService:{refresh:async()=>{}}},
 'services/dailyReward.service.ts':{dailyRewardService:{settleCheckins:async()=>true,getCheckinRewardView:async(_c,day)=>({policyVersion:2,effectiveDate:'2020-01-01',localDate:day,status:'waiting',baseCoin:0,bonusCoin:0,coinAwarded:0,commonStreak:null})}},
})('services/checkin.service.ts').checkinService;
let questKey='daily_checkin';
const questRepository={findByKey:async()=>({key:questKey,type:'checkin',active:true,coinReward:10,expReward:5}),ensureProgress:async()=>{},setProgress:async()=>{},findOne:async()=>progress,
 markRewarded:async(_c,_k,_d,_u,intent)=>{if(progress.status!=='completed')return null;progress={...progress,status:'rewarded',rewardIntent:intent};return progress;}};
const questService=loader({...common,'repositories/quest.repository.ts':{questRepository},'models/Quest.ts':{QuestProgress:{updateOne:()=>query(()=>{})}},
 'repositories/checkin.repository.ts':{checkinRepository:{findForCoupleDate:async()=>[{},{}]}},
 'models/DuoMoment.ts':{MOMENT_SCHEDULE_VERSION:3,momentRewardProgress:()=>2},'repositories/coupleSettings.repository.ts':{},'repositories/question.repository.ts':{},'repositories/moment.repository.ts':{},
})('services/quest.service.ts').questService;
(async()=>{
 const result=await checkinService.checkin(couple,String(a));assert.equal(result.coinAwarded,0);assert.equal(result.expAwarded,5);assert.equal(inputs[0].coin,0);assert.equal(inputs[0].exp,5);assert.equal(inputs[0].provenance.component,'checkin_exp');
 const {getLocalDate,zonedTimeToUtc,addDays}=loader()('utils/date.ts');const today=getLocalDate(new Date(),couple.dailyRewardPolicy.timezone);
 assert.equal(checkin.localDate,today);assert.equal(+checkin.dayOpensAt,+zonedTimeToUtc(today,'00:00',couple.dailyRewardPolicy.timezone));assert.equal(+checkin.dayClosesAt,+zonedTimeToUtc(addDays(today,1),'00:00',couple.dailyRewardPolicy.timezone));
 const frozen=checkin.rewardIntent;await checkinService.checkin(couple,String(a));assert.equal(checkin.rewardIntent,frozen);
 for(const key of ['daily_checkin','duo_moment']){
  questKey=key;progress={_id:new Types.ObjectId(),localDate:today,status:'completed',progress:2,target:2};
  const view=await questService.claim(couple,String(a),key);assert.equal(view.coinReward,0);assert.equal(view.expReward,5);assert.equal(view.rewardPolicy.version,2);
  const intent=progress.rewardIntent;await questService.claim(couple,String(b),key);assert.equal(progress.rewardIntent,intent);assert.equal(inputs.at(-1).actorUserId,String(a));assert.equal(inputs.at(-1).coin,0);assert.equal(inputs.at(-1).exp,5);
 }
 questKey='duo_moment';progress={_id:new Types.ObjectId(),localDate:today,status:'rewarded',progress:2,target:2,rewardIntent:{operationId:'legacy',actorUserId:String(a),ownerUserId:null,coin:40,exp:5}};
 const legacy=await questService.claim(couple,String(b),questKey);assert.equal(legacy.coinReward,40);assert.equal(legacy.rewardPolicy.version,1);assert.equal(inputs.at(-1).coin,40);assert.equal(inputs.at(-1).provenance,undefined,'legacy intent remains byte-shape compatible');
 console.log('PASS v2 reward sources: zero personal coins +5 EXP, zero claim coins +5 EXP, frozen policy timezone, immutable claimant and legacy40 replay');
})().catch(e=>{console.error(e);process.exitCode=1;});
