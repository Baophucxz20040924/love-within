'use strict';
const assert = require('node:assert/strict');
const { loader, quiet, mongoose } = require('./harness.cjs');
const id = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24,'0'));
const couple = { _id: id(1), memberIds: [id(2),id(3)] }, storyId = id(4);
let visible = true, reads = 0, names = 0, lastLimit;
const rows = Array.from({length: 521}, (_,n) => ({ _id:id(n+10), coupleId:couple._id, storyId,
  authorId:id(2), body:`comment ${n}`, createdAt:new Date('2026-11-18T00:00:00.000Z'), deletedAt:null }));
rows.push({...rows[0],_id:id(999),deletedAt:new Date()}, {...rows[0],_id:id(1000),storyId:id(5)});
function matches(r,f) { return Object.entries(f).every(([k,v]) => k==='$or' ? v.some(x=>matches(r,x))
  : v && typeof v==='object' && '$lt' in v ? r[k]<v.$lt : r[k]==null ? v==null : String(r[k])===String(v)); }
const StoryComment = { find(filter) { return { sort(order) { this.order=order; return this; }, limit(n) { lastLimit=n; return this; },
  exec:async()=>rows.filter(r=>matches(r,filter)).sort((a,b)=>String(b._id).localeCompare(String(a._id))).slice(0,lastLimit) }; } };
const load = loader({ ...quiet, 'models/Story.ts': { Story:{} }, 'models/StoryComment.ts': { StoryComment } });
const repo = load('repositories/story.repository.ts');
const service = loader({ ...quiet,
  'config/env.ts': {env:{}}, 'integrations/index.ts': {}, 'services/storyMedia.service.ts': {},
  'repositories/user.repository.ts': {userRepository:{findDisplayNames:async()=>{names++;return new Map([[String(id(2)),'Member']]);}}},
  'repositories/story.repository.ts': { ...repo, storyRepository:{findById:async(cid,sid)=>{reads++;assert.equal(String(cid),String(couple._id));assert.equal(String(sid),String(storyId));return visible?{_id:storyId}:null;}} },
})('services/story.service.ts').storyService;
(async()=>{
  let cursor, collected=[];
  do {
    const page=await service.listCommentsPage(couple,String(id(2)),String(storyId),{limit:20,cursor});
    assert.equal(lastLimit,21);assert.ok(page.items.length<=20);collected.push(...page.items);cursor=page.nextCursor;
  }while(cursor);
  assert.equal(collected.length,521);assert.equal(new Set(collected.map(r=>r.id)).size,521);assert.equal(reads,27);assert.equal(names,27);
  assert.ok(collected.every(r=>r.isMine && r.author.displayName==='Member'));
  const first=await service.listCommentsPage(couple,String(id(2)),String(storyId),{limit:20});
  visible=false;await assert.rejects(service.listCommentsPage(couple,String(id(2)),String(storyId),{limit:20,cursor:first.nextCursor}),e=>e.status===404);
  await assert.rejects(service.listCommentsPage({...couple,_id:id(6)},String(id(2)),String(storyId),{limit:20,cursor:first.nextCursor}),e=>e.status===400);
  assert.ok(Array.isArray(await repo.storyCommentRepository.list(couple._id,storyId)));assert.equal(lastLimit,500);
  console.log('PASS comment pages: 521 timestamp-tied live rows, scoped seek, live story check on every page, cross-scope cursor, legacy cap');
})().catch(e=>{console.error(e);process.exitCode=1;});
