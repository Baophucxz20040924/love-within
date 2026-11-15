'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const a = new Types.ObjectId(), b = new Types.ObjectId();
const couple = { _id: new Types.ObjectId(), memberIds: [a,b], timezone: 'UTC' };
const query = value => ({ exec: async () => typeof value === 'function' ? value() : value });
let paid = new Map(), fault = false, intents = [];
const walletService = { reward: async input => {
  intents.push(input); if (!paid.has(input.operationId)) paid.set(input.operationId, input);
  if (fault) { fault = false; throw Error('payment outcome unknown'); }
  return { coin: 10, exp: 9, level: 1 };
} };
let checkin;
const checkinRepo = {
  findByDate: async () => checkin, findLatest: async () => null,
  create: async input => checkin = { ...input, _id: new Types.ObjectId(), rewardCompletedAt: null },
  findForCoupleDate: async () => checkin ? [checkin] : [],
};
const checkinService = loader({ ...quiet, 'models/Checkin.ts': { Checkin: { updateOne: () => query(() => { checkin.rewardCompletedAt = new Date(); }) } },
  'repositories/checkin.repository.ts': { checkinRepository: checkinRepo }, 'services/wallet.service.ts': {walletService},
  'services/quest.service.ts': {questService:{refresh:async()=>{}}},
})('services/checkin.service.ts').checkinService;
let progress;
const questRepo = {
  findByKey: async () => ({key:'daily_checkin', type:'checkin', active:true, coinReward:5, expReward:9}),
  ensureProgress: async () => {}, setProgress: async () => {}, findOne: async () => progress,
  markRewarded: async (_c,_k,_d,_u,rewardIntent) => { if(progress.status!=='completed') return null; progress = {...progress,status:'rewarded',rewardIntent}; return progress; },
};
const questService = loader({ ...quiet, 'models/Quest.ts': {QuestProgress:{updateOne:()=>query(()=>{progress.rewardCompletedAt=new Date();})}},
  'repositories/quest.repository.ts':{questRepository:questRepo}, 'repositories/checkin.repository.ts':{checkinRepository:{findForCoupleDate:async()=>[{},{}]}},
  'models/DuoMoment.ts': { momentRewardProgress: () => 0, MOMENT_SCHEDULE_VERSION: 3 },
  'repositories/coupleSettings.repository.ts':{}, 'repositories/question.repository.ts':{}, 'repositories/moment.repository.ts':{},
  'services/wallet.service.ts':{walletService},
})('services/quest.service.ts').questService;
let item, markFault = false, slotFault = false, slotKeys = new Set();
const bucketRepo = {
  findById:async()=>item,
  markDone:async(_c,_i,done,rewardIntent)=>{item={...item,...done,status:'done',...(rewardIntent?{rewardIntent,rewardedAt:done.doneAt}:{})};if(markFault){markFault=false;throw Error('markDone fault');}return item;},
};
const bucketModel = { updateOne: (_filter, update) => query(() => Object.assign(item, update.$set)) };
const bucketService = loader({...quiet, 'models/BucketItem.ts': {BucketItem:bucketModel,BUCKET_CATEGORIES:[],BUCKET_CATEGORY_INFO:{}},
  'config/bucketIdeas.ts':{}, 'repositories/bucket.repository.ts':{bucketRepository:bucketRepo,bucketRewardDayRepository:{take:async(_c,_d,_max,id)=>{slotKeys.add(id);if(slotFault){slotFault=false;throw Error('slot fault');}return true;}}},
  'repositories/story.repository.ts':{storyRepository:{aliveIds:async()=>new Set()}}, 'services/story.service.ts':{},
  'services/wallet.service.ts':{walletService},
})('services/bucket.service.ts').bucketService;
(async()=>{
  checkin=null; fault=true;
  await assert.rejects(checkinService.checkin(couple,String(a)),/unknown/);
  const first=checkin.rewardIntent; await checkinService.checkin(couple,String(a));
  assert.equal(paid.size,1); assert.equal(intents.at(-1).ownerUserId,String(a)); assert.equal(checkin.rewardIntent,first);
  checkin={...checkin,rewardIntent:null}; const before=paid.size; await assert.rejects(checkinService.checkin(couple,String(a)),e=>e.status===409); assert.equal(paid.size,before);
  paid.clear();intents=[];progress={_id:new Types.ObjectId(),status:'completed',localDate:'2026-01-01',progress:2,target:2};fault=true;
  await assert.rejects(questService.claim(couple,String(a),'daily_checkin'),/unknown/);
  const claimed=progress.rewardIntent; await questService.claim(couple,String(b),'daily_checkin');
  assert.equal(paid.size,1); assert.equal(intents.at(-1).actorUserId,String(a),'retrying partner cannot change frozen actor'); assert.equal(intents.at(-1).ownerUserId,null); assert.equal(progress.rewardIntent,claimed);
  progress.rewardIntent=null;await assert.rejects(questService.claim(couple,String(b),'daily_checkin'),e=>e.status===409);
  paid.clear();intents=[];slotKeys.clear();
  item={_id:new Types.ObjectId(),coupleId:couple._id,title:'fixture',status:'todo',createdAt:new Date(Date.now()-3*86400000),createdBy:a,updatedBy:a,updatedAt:new Date(),rewardedAt:null,rewardIntent:null,storyId:null};fault=true;
  const failed=await bucketService.complete(couple,String(a),String(item._id),{photos:[],postStory:false});
  assert.equal(failed.rewardSkipped.reason,'failed'); assert.ok(item.rewardIntent);assert.equal(item.rewardCompletedAt,undefined);
  const recovered=await bucketService.complete(couple,String(b),String(item._id),{photos:[],postStory:false});
  assert.ok(recovered.reward);assert.equal(paid.size,1);assert.equal(slotKeys.size,1);assert.equal(intents.at(-1).actorUserId,String(a));assert.equal(intents.at(-1).ownerUserId,null);
  item.rewardIntent=null;item.completion=null;await assert.rejects(bucketService.complete(couple,String(a),String(item._id),{photos:[],postStory:false}),e=>e.status===409);
  for(const boundary of ['markDone','slot']) {
    paid.clear();slotKeys.clear();intents=[];
    item={_id:new Types.ObjectId(),coupleId:couple._id,title:'crash fixture',status:'todo',createdAt:new Date(Date.now()-3*86400000),updatedAt:new Date(),createdBy:a,updatedBy:a,rewardedAt:null,rewardIntent:null,storyId:null};
    markFault=boundary==='markDone';slotFault=boundary==='slot';
    await assert.rejects(bucketService.complete(couple,String(a),String(item._id),{photos:[],postStory:false}),/fault/);
    assert.ok(item.rewardIntent,'source intent exists in same durable completion');assert.equal(item.completion.ready,true);
    await bucketService.complete(couple,String(b),String(item._id),{photos:[],postStory:false});
    assert.equal(paid.size,1);assert.equal(slotKeys.size,1);assert.equal(intents.at(-1).actorUserId,String(a));
  }
  console.log('PASS reward sources: durable checkin/quest/bucket intents, frozen claimant, no historical replay, no guard reset after unknown payment');
})().catch(e=>{console.error(e);process.exitCode=1;});
