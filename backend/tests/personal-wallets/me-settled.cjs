'use strict';
const assert=require('node:assert/strict');
const {loader,quiet,mongoose}=require('./harness.cjs');
const id=n=>new mongoose.Types.ObjectId(n.toString(16).padStart(24,'0'));
const cid=id(1),uid=String(id(2)),other=String(id(3));
let wallet={version:2,memberIds:[uid,other],revision:0,balances:{[uid]:5,[other]:6},pending:null};
let couple={_id:cid,memberIds:[id(2),id(3)],exp:9,level:1};
const query=fn=>({exec:async()=>fn()});
const load=loader({...quiet,'models/Couple.ts':{Couple:{findById:()=>query(()=>couple)}},'models/Wallet.ts':{Wallet:{findOne:()=>query(()=>wallet)}}});
const {walletRepository:repo}=load('repositories/wallet.repository.ts');
(async()=>{
 assert.equal((await repo.readSettled(cid,uid)).wallet.balances[uid],5);
 const original=wallet;
 for(const patch of [{pending:{operationId:'pending'}},{version:1},{revision:-1},{balances:{[uid]:NaN,[other]:0}},{memberIds:[other,uid]}]){wallet={...original,...patch};await assert.rejects(repo.readSettled(cid,uid),e=>e.code==='WALLET_REVIEW_REQUIRED');}
 wallet=null;await assert.rejects(repo.readSettled(cid,uid));wallet=original;
 await assert.rejects(repo.readSettled(cid,String(id(4))),e=>e.status===403);
 const originalCouple=couple;couple=null;await assert.rejects(repo.readSettled(cid,uid),e=>e.status===404);couple=originalCouple;
 let repaired=false,read=false;
 const serviceLoad=loader({...quiet,'models/Couple.ts':{Couple:{}},'repositories/wallet.repository.ts':{walletRepository:{getOrCreate:async()=>wallet,readSettled:async()=>{assert.equal(repaired,true);read=true;return{wallet,couple};}},walletReview:()=>Error('review')}});
 const service=serviceLoad('services/wallet.service.ts').walletService;
 service.recoverRewards=async()=>{repaired=true;couple.exp=250;};
 const settled=await service.getSettledView(cid,uid);assert.equal(read,true);assert.equal(settled.wallet.exp,250);assert.equal(settled.couple.exp,250);
 const failure=Error('repair failed');read=false;
 service.recoverRewards=async()=>{throw failure;};
 await assert.rejects(service.getSettledView(cid,uid),e=>e===failure);assert.equal(read,false);
 // Controller uses the returned post-repair couple; it must not build from the first active lookup.
 let built,body,user={_id:id(2),coupleId:cid},active=true,repairError=null,repairs=0,lookups=0;
 const controller=loader({...quiet,'repositories/user.repository.ts':{userRepository:{findById:async()=>user}},'repositories/couple.repository.ts':{coupleRepository:{findActiveById:async()=>{lookups++;return active?{...couple,exp:0}:null;}}},'services/wallet.service.ts':{walletService:{getSettledView:async()=>{repairs++;if(repairError)throw repairError;return settled;}}},'services/couple.service.ts':{buildCoupleView:async c=>{built=c;return{exp:c.exp,level:c.level};}},'services/profile.service.ts':{avatarUrlOf:async()=>null},'utils/response.ts':{ok:(_res,data)=>body=data}})('controllers/me.controller.ts').meController;
 await controller.get({userId:uid},{});assert.equal(built.exp,250);assert.equal(body.couple.exp,body.wallet.exp);assert.equal(body.exp,body.wallet.exp);assert.equal(body.couple.level,body.wallet.level);
 repairError=failure;body=undefined;built=undefined;
 await assert.rejects(controller.get({userId:uid},{}),e=>e===failure);assert.equal(body,undefined);assert.equal(built,undefined);repairError=null;
 const before=repairs;user={_id:id(2)};const priorLookups=lookups;
 await controller.get({userId:uid},{});assert.equal(repairs,before);assert.equal(lookups,priorLookups);assert.equal(body.couple,null);assert.equal(body.wallet,null);assert.equal(body.exp,0);assert.equal(body.level,1);
 user={_id:id(2),coupleId:cid};active=false;
 await controller.get({userId:uid},{});assert.equal(repairs,before);assert.equal(body.user.coupleId,null);assert.equal(body.couple,null);assert.equal(body.wallet,null);
 user=null;body=undefined;await assert.rejects(controller.get({userId:uid},{}),e=>e.status===401);assert.equal(body,undefined);
 console.log('PASS settled /me: fail-closed read validation, awaited repair/error ordering, unpaired/missing state and coherent post-repair EXP');
})().catch(e=>{console.error(e);process.exitCode=1;});
