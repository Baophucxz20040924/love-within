'use strict';
const assert = require('node:assert/strict');
const {loader,quiet,mongoose}=require('./harness.cjs');
const {Types}=mongoose;
const couple={_id:new Types.ObjectId()},author=new Types.ObjectId(),id=new Types.ObjectId();
let item,story,fail,creates,stale;
const q=fn=>({exec:async()=>fn()});
function reset(){item={_id:id,doneAt:new Date(),completion:{version:1,ready:false,story:{id:String(new Types.ObjectId()),actorUserId:String(author),body:'frozen',happenedOn:'2026-01-01',photos:[]}}};story=null;fail=null;creates=0;stale=false;}
const model={
  findOneAndUpdate:(filter)=>q(()=>{assert.equal(filter.doneAt,item.doneAt);assert.equal(filter['completion.story.id'],item.completion.story.id);if(stale)return null;item.completion.ready=true;item.storyId=story._id;if(fail==='promotion'){fail=null;throw Error('promotion fault');}return item;}),
  findOne:()=>q(()=>stale?null:item),
};
const fingerprint=content=>JSON.stringify({body:content.body,authorId:String(content.authorId),coupleId:String(content.coupleId)});
const overrides={...quiet,
 'models/BucketItem.ts':{BucketItem:model},
 'repositories/story.repository.ts':{storyCreationFingerprint:fingerprint,storyRepository:{findReserved:async(_c,_id,a)=>{assert.equal(String(a),String(author));return story;}}},
 'services/story.service.ts':{storyService:{create:async(c,user,content,opts)=>{creates++;assert.equal(user,String(author));assert.equal(String(opts.reservedId),item.completion.story.id);story={_id:opts.reservedId,creationFingerprint:fingerprint(content)};if(fail==='story'){fail=null;throw Error('story fault');}}}},
};
delete overrides['services/bucketCompletion.service.ts'];
const finish=loader(overrides)('services/bucketCompletion.service.ts').finishBucketCompletion;
(async()=>{
 for(const boundary of ['story','promotion']){reset();fail=boundary;await assert.rejects(finish(couple,item),/fault/);await finish(couple,item);assert.equal(creates,1);assert.equal(item.completion.ready,true);}
 reset();story={_id:new Types.ObjectId(item.completion.story.id),creationFingerprint:fingerprint({body:'frozen',authorId:author,coupleId:couple._id}),deletedAt:new Date()};await finish(couple,item);assert.equal(creates,0,'soft-deleted success never recreated');
 reset();story={_id:new Types.ObjectId(item.completion.story.id),creationFingerprint:'wrong'};await assert.rejects(finish(couple,item),e=>e.status===409);assert.equal(item.completion.ready,false);
 reset();stale=true;assert.equal(await finish(couple,item),false);assert.equal(item.completion.ready,false,'stale completion cannot promote');
 reset();item.completion=null;assert.equal(await finish(couple,item),true);assert.equal(creates,0,'historical row never invents story intent');
 // Exercise the actual repository CAS through a complete→reopen ABA cycle, with both paid and pending claims.
 let row;
 const casModel={findOneAndUpdate:(filter,update)=>q(()=>{
   for(const [key,value] of Object.entries(filter)){
     const actual=key.split('.').reduce((v,k)=>v?.[k],row);
     if(value===null){if(actual!=null)return null;}
     else if(value && typeof value==='object' && '$ne' in value){if(actual===value.$ne)return null;}
     else if(value && typeof value==='object' && '$gte' in value){if(!(actual>=value.$gte))return null;}
     else if(String(actual)!==String(value))return null;
   }
   Object.assign(row,update.$set);return {...row};
 })};
 const repo=loader({...quiet,'models/BucketItem.ts':{BucketItem:casModel}})('repositories/bucket.repository.ts').bucketRepository;
 for(const paid of [false,true]){
   row={_id:id,coupleId:couple._id,status:'todo',deletedAt:null,rewardIntent:null,rewardedAt:null};
   const firstDate=new Date('2026-01-01T12:00:00Z');
   const original={operationId:`bucket:${id}`,actorUserId:String(author),coin:5,exp:9,ownerUserId:null,localDate:'2026-01-01'};
   const done={doneOn:'2026-01-01',doneBy:author,doneAt:firstDate,doneNote:'',completion:{version:1,ready:true,story:null}};
   assert.ok(await repo.markDone(couple._id,id,done,original));
   if(paid)row.rewardCompletedAt=new Date();
   assert.ok(await repo.reopen(couple._id,id,new Date('2026-01-01T00:00:00Z'),author));
   const stale={...original,actorUserId:String(new Types.ObjectId()),localDate:'2026-01-02'};
   assert.equal(await repo.markDone(couple._id,id,{...done,doneAt:new Date()},stale),null,'stale eligible request must conflict after reopen');
   assert.equal(row.rewardIntent,original);assert.equal(row.rewardedAt,firstDate);
   assert.ok(await repo.markDone(couple._id,id,{...done,doneAt:new Date()},null),'intent-aware intentional recompletion remains allowed');
   assert.equal(row.rewardIntent,original);assert.equal(row.rewardedAt,firstDate);
 }
 console.log('PASS bucket completion: reserved story faults, soft-deleted replay, immutable payload, stale gate and reward-intent ABA fence');
})().catch(e=>{console.error(e);process.exitCode=1;});
