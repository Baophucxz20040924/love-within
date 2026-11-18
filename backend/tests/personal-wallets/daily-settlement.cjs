'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const { Types } = mongoose;
const a = new Types.ObjectId('000000000000000000000001'), b = new Types.ObjectId('000000000000000000000002');
const couple = { _id: new Types.ObjectId(), memberIds: [b, a], timezone: 'UTC',
  dailyRewardPolicy: { version: 2, effectiveDate: '2026-01-01', timezone: 'UTC', activatedAt: new Date('2026-01-01') } };
const days = new Map(), moments = new Map(), settlements = new Map(), claims = new Map(), operations = new Map();
let fault = null, queryCount = 0, settlementAttempts = 0;
const key = (day, component, who = 'pair') => `${day}:${component}:${who}`;
const policy = { ensure: async c => c.dailyRewardPolicy, forDay: async (c, day) => ({ ...c.dailyRewardPolicy, version: day >= c.dailyRewardPolicy.effectiveDate ? 2 : 1 }) };
const repo = {
  find: async (_c, day, component, who) => settlements.get(key(day, component, who)),
  listDays: async (_c, dates) => { queryCount++; return [...settlements.values()].filter(row => dates.includes(row.localDate)); },
  frozenMomentQuests: async (_c, dates) => { queryCount++; return dates.map(day => claims.get(`duo_moment:${day}`)).filter(Boolean); },
  frozenQuest: async (_c, quest, day) => claims.get(`${quest}:${day}`),
  ensure: async input => {
    settlementAttempts++;
    const id = key(input.localDate, input.component, input.beneficiary);
    if (!settlements.has(id)) settlements.set(id, { ...input, _id: new Types.ObjectId(), completedAt: null });
    if (fault === 'intent') { fault = null; throw Error('crash after intent'); }
    return settlements.get(id);
  },
  complete: async id => {
    const row = [...settlements.values()].find(x => String(x._id) === String(id));
    row.completedAt = new Date();
    if (fault === 'complete') { fault = null; throw Error('crash after completion'); }
  },
  pending: async (_c, limit) => [...settlements.values()].filter(row => !row.completedAt).sort((x,y) => x.localDate.localeCompare(y.localDate)).slice(0, limit),
  pendingCheckins: async (_c, limit) => [...days.values()].flat().filter(row => row.dailySettlementPending).sort((x,y) => x.localDate.localeCompare(y.localDate)).slice(0,limit),
  clearCheckins: async ids => { for (const row of [...days.values()].flat()) if (ids.includes(row._id)) row.dailySettlementPending = false; },
  pendingMoments: async (_c,limit) => [...moments.values()].filter(day => day.rewardSettlementPending).slice(0,limit),
  clearMoment: async day => { day.rewardSettlementPending = false; },
};
const walletService = { reward: async input => {
  const payload = JSON.stringify(input);
  if (operations.has(input.operationId)) assert.equal(operations.get(input.operationId).payload, payload, 'operation immutable on replay');
  else operations.set(input.operationId, { ...input, payload });
  if (fault === 'wallet') { fault = null; throw Error('crash after wallet'); }
  return { coin: 0 };
} };
const load = loader({ ...quiet,
  'services/rewardPolicy.service.ts': { rewardPolicyService: policy },
  'services/wallet.service.ts': { walletService },
  'repositories/checkin.repository.ts': { checkinRepository: { findForCoupleDate: async (_c,day) => days.get(day) ?? [] } },
  'repositories/moment.repository.ts': { momentRepository: { findDay: async (_c,day) => moments.get(day) } },
  'repositories/dailyReward.repository.ts': { dailyRewardRepository: repo },
});
const { dailyRewardService: service, momentEligibility } = load('services/dailyReward.service.ts');
function reset() { days.clear(); moments.clear(); settlements.clear(); claims.clear(); operations.clear(); fault = null; queryCount = 0; settlementAttempts = 0; }
function checkin(day,user,legacy = false) {
  const row = { _id:new Types.ObjectId(), coupleId:couple._id, userId:user, localDate:day, dailySettlementPending:true,
    rewardIntent: { operationId:`individual:${day}:${user}`, actorUserId:String(user), ownerUserId:String(user),coin:legacy?10:0,exp:5,
      ...(!legacy ? {provenance:{version:1,policyVersion:2,source:'checkin',component:'checkin_exp',localDate:day,baseCoin:0,bonusCoin:0}} : {}) } };
  days.set(day,[...(days.get(day)??[]),row]); return row;
}
function pair(day) { checkin(day,a);checkin(day,b); }
function day(day, offsetA = 0, offsetB = null) {
  const promptAt = new Date(`${day}T10:00:00Z`), rewardEndsAt = new Date(+promptAt+30*60_000), closesAt = new Date(`${day}T23:59:59Z`);
  const post = (user, offset) => ({userId:user,key:'valid-photo',width:10,height:10,caption:'',postedAt:new Date(+promptAt+offset),lateMin:0});
  const doc = {_id:new Types.ObjectId(),coupleId:couple._id,localDate:day,scheduleVersion:3,rewardSettlementPending:true,
    sessions:[{id:'fixture',promptAt,rewardEndsAt,closesAt,posts:[...(offsetA==null?[]:[post(a,offsetA)]),...(offsetB==null?[]:[post(b,offsetB)])]}]};
  moments.set(day,doc); return doc;
}
function total(user) { return [...operations.values()].reduce((n,op)=>n+(op.allocations?.[String(user)]??0),0); }
(async()=>{
  checkin('2026-01-01',a);
  await service.settleCheckins(couple,'2026-01-01'); assert.equal(operations.size,0,'first checkin no coins');
  await service.recoverCouple(couple); assert.equal(days.get('2026-01-01')[0].dailySettlementPending,false);
  checkin('2026-01-01',b);
  await Promise.all(Array.from({length:12},()=>service.settleCheckins(couple,'2026-01-01')));
  assert.equal(operations.size,1); assert.equal(total(a),5);assert.equal(total(b),5);
  pair('2026-01-02'); await service.settleCheckins(couple,'2026-01-02'); assert.equal(total(a),11);
  pair('2026-01-04'); await service.settleCheckins(couple,'2026-01-04'); assert.equal(total(a),16,'gap resets common streak');
  const v = await service.getCheckinRewardView(couple,'2026-01-02',String(a)); assert.equal(v.commonStreak,2);assert.equal(v.baseCoin,5);assert.equal(v.bonusCoin,1);assert.equal(v.coinAwarded,6);
  reset(); pair('2026-01-01');pair('2026-01-02');
  await service.settleCheckins(couple,'2026-01-02'); assert.equal(settlements.get(key('2026-01-01','checkin_pair')).commonStreak,1); assert.equal(settlements.get(key('2026-01-02','checkin_pair')).commonStreak,2);
  for (const boundary of ['intent','wallet','complete']) {
    reset(); pair('2026-01-01'); fault=boundary;
    await assert.rejects(service.settleCheckins(couple,'2026-01-01'),/crash/);
    await service.recoverCouple(couple);await service.recoverCouple(couple);
    assert.equal(operations.size,1); assert.equal(total(a),5);assert.equal([...settlements.values()][0].completedAt instanceof Date,true);
  }
  reset(); for(let n=1;n<=25;n++) pair(`2026-01-${String(n).padStart(2,'0')}`);
  assert.equal(await service.settleCheckins(couple,'2026-01-25'),false);assert.equal(settlements.size,0,'do not guess streak beyond predecessor bound');
  for(let n=0;n<4;n++) await service.recoverCouple(couple);
  assert.equal(settlements.size,25);assert.equal(settlements.get(key('2026-01-25','checkin_pair')).commonStreak,25);
  reset();pair('2025-12-31'); await service.settleCheckins(couple,'2025-12-31');assert.equal(operations.size,0,'no legacy backpay');
  checkin('2026-01-01',a,true);checkin('2026-01-01',b);await service.settleCheckins(couple,'2026-01-01');assert.equal(operations.size,0,'frozen legacy individual blocks additive pair payout');
  reset();pair('2026-01-01');days.get('2026-01-01')[0].rewardIntent=null;
  await service.settleCheckins(couple,'2026-01-01');assert.equal(operations.size,0,'missing historical intent is not proof for a new payout');
  reset();pair('2026-01-02');settlements.set(key('2026-01-01','checkin_pair'),{commonStreak:Number.MAX_SAFE_INTEGER,completedAt:new Date()});
  await assert.rejects(service.settleCheckins(couple,'2026-01-02'),e=>e.code==='WALLET_REVIEW_REQUIRED');
  reset(); let m=day('2026-01-01');await service.settleMoments(couple,m);assert.equal(total(a),10);assert.equal(total(b),0);
  let mv=await service.getMomentRewardView(couple,m,String(a));assert.equal(mv.status,'awarded');assert.equal(mv.coinAwarded,10);
  m=day('2026-01-01',0,1);await Promise.all(Array.from({length:8},()=>service.settleMoments(couple,m)));
  assert.equal(total(a),20);assert.equal(total(b),20);assert.equal(operations.size,3,'two bases plus one pair operation');
  mv=await service.getMomentRewardView(couple,m,String(a));assert.equal(mv.bonusCoin,10);assert.equal(mv.coinAwarded,20);
  reset();m=day('2026-01-01',0,30*60_000);await service.settleMoments(couple,m);assert.equal(total(a),10);assert.equal(total(b),10,'exact server deadline is late');
  m.sessions[0].posts[1].lateMin=0;assert.equal(momentEligibility(m,[String(a),String(b)]).timelyPair,false,'client/computed lateMin not authoritative');
  reset();m=day('2026-01-01',-1,0);await service.settleMoments(couple,m);assert.equal(total(a),0);assert.equal(total(b),10,'before prompt invalid');
  for(const boundary of ['intent','wallet','complete']) {
    reset();m=day('2026-01-01',0,1);fault=boundary;
    await assert.rejects(service.settleMoments(couple,m),/crash/);
    await service.recoverCouple(couple);await service.recoverCouple(couple);assert.equal(total(a),20);assert.equal(total(b),20);assert.equal(operations.size,3);
  }
  reset();m=day('2026-01-01',0,1);claims.set('duo_moment:2026-01-01',{localDate:m.localDate,rewardIntent:{operationId:'legacy40',actorUserId:String(b),coin:40,exp:5,ownerUserId:null}});
  await service.settleMoments(couple,m); assert.equal(operations.size,0);assert.equal((await service.getMomentRewardView(couple,m,String(a))).status,'legacy');
  reset();m=day('2026-01-01',0,1);claims.set('duo_moment:2026-01-01',{localDate:m.localDate,status:'rewarded',rewardIntent:null});
  await service.settleMoments(couple,m);assert.equal(operations.size,0,'ambiguous historical paid claim is never backfilled');
  reset();const calendar=Array.from({length:31},(_,n)=>day(`2026-01-${String(n+1).padStart(2,'0')}`));
  const views=await service.getMomentRewardViews(couple,calendar,String(a));assert.equal(views.size,31);assert.equal(queryCount,2,'calendar uses fixed batch queries');assert.equal(views.get('2026-01-01').status,'pending');
  console.log('PASS daily settlement: common streak, gap, bounded predecessor repair, source-before-intent crashes, concurrency, legacy freeze, unsafe integer, server-time moments and batch views');
})().catch(e=>{console.error(e);process.exitCode=1;});
