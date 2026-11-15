'use strict';
// Actual hooks/callbacks with fake React, clock, transport and session identities. No DOM/browser/server.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const ts=require('typescript');
function load(relative,mocks,globals={},testExports=[]){
  const filename=path.resolve(__dirname,'../src',relative);
  const source=fs.readFileSync(filename,'utf8')+(testExports.length?`\nexport { ${testExports.join(', ')} };`:'');
  const code=ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}};vm.runInNewContext(code,{module:mod,exports:mod.exports,Date,Error,console,...globals,require(name){assert.ok(Object.hasOwn(mocks,name),name);return mocks[name];}},{filename});return mod.exports;
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function find(node,predicate){if(Array.isArray(node)){for(const child of node){const found=find(child,predicate);if(found)return found;}}else if(node&&node.props){if(predicate(node))return node;return find(node.props.children,predicate);}}
const tick=()=>new Promise(r=>setImmediate(r));
const helpers=load('features/moments/api.ts',{
  '../../lib/apiClient':{},'../../lib/image':{},'../couple/api':{PULSE_KEY:['pulse']},'../quests/api':{QUESTS_KEY:['quests']},
});
function text(node){if(Array.isArray(node))return node.map(text).join('');if(node?.props)return text(node.props.children);return node==null?'':String(node);}
function harness(){
  let now=Date.parse('2026-11-15T09:00Z'),generation='A',epoch=0,lock=0,discard=false,cursor=0;
  const cells=[],pendingEffects=[],cleanups=[],timers=[],events={},calls={post:[],upload:[],toast:[],refresh:[],revoked:[],state:[]};
  const upload=deferred(),post=deferred();
  class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
  class ApiError extends Error{constructor(status,code,message){super(message);this.code=code;this.status=status;}}
  const react={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;calls.state.push(i);}];},
    useRef(initial){const i=cursor++;return cells[i]??={current:initial};},
    useEffect(fn,deps){const i=cursor++;if(!(i in cells)||deps.some((d,n)=>d!==cells[i][n])){cells[i]=deps;pendingEffects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
  const jsx=(type,props)=>({type,props:props||{}});
  const api={...helpers,uploadMomentPhoto:(...a)=>{calls.upload.push(a);return upload.promise;},momentsApi:{post:input=>{calls.post.push(input);return post.promise;}},refreshMoments:async()=>calls.refresh.push(1),MAX_MOMENT_CAPTION:100};
  const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'@tanstack/react-query':{useQueryClient:()=>({})},
    '../../components/BottomSheet':{BottomSheet:'Sheet'},'../../components/Icon':{Icon:'Icon'},'../../components/Toast':{useToast:()=>({success:s=>calls.toast.push(s),error:s=>calls.toast.push(s)})},
    '../../lib/apiClient':{ApiRequestError:ApiError,currentAccessEpoch:()=>epoch},'../../lib/format':{formatTime:String},
    '../../lib/tokenStore':{tokenStore:{generation:()=>generation,isCurrent:g=>g===generation}},'../appLock/store':{appLockEpoch:()=>lock,appLockState:()=>({discard}),isAppLocked:()=>discard},'./api':api};
  const win={setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},addEventListener:(name,fn)=>events[name]=fn,removeEventListener(){}};
  const globals={Date:Clock,window:win,document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name]=fn,removeEventListener(){}},URL:{createObjectURL:()=> 'blob:mock',revokeObjectURL:url=>calls.revoked.push(url)}};
  const views=load('features/moments/MomentViews.tsx',mocks,globals);
  const render=(fn,props)=>{cursor=0;const tree=fn(props);while(pendingEffects.length)pendingEffects.shift()();return tree;};
  return{views,render,cells,calls,upload,post,timers,events,mocks,globals,unmount:()=>cleanups.forEach(fn=>fn?.()),setNow:v=>now=+new Date(v),switchAccount:()=>generation='B',changeAccess:()=>epoch++,resume:()=>{lock++;epoch++;},lock:()=>{lock++;discard=true;}};
}
const target={localDate:'2026-11-15',sessionId:'session-A'},promptAt='2026-11-15T09:00:00Z',rewardEndsAt='2026-11-15T09:30:00Z',closesAt='2026-11-16T00:00:00Z';
const session={...target,scheduleVersion:3,legacy:false,state:'open',promptAt,rewardEndsAt,closesAt,closed:false,mine:null,partner:{posted:false,postedAt:null,photo:null}};
const file={name:'photo.jpg',lastModified:1,size:10,type:'image/jpeg'};
test('both deadline hooks refresh on timer/focus/visibility; only midnight closes capture',()=>{
  const h=harness();const read=()=>h.render(()=>h.views.useMomentNow(closesAt,rewardEndsAt));
  assert.equal(read(),Date.parse(promptAt));assert.equal(h.timers.length,3);
  h.setNow(rewardEndsAt);h.timers[1]();assert.equal(read(),Date.parse(rewardEndsAt));
  assert.equal(h.views.canCapture(session,Date.parse(promptAt)-1),false);
  assert.equal(h.views.canCapture(session,Date.parse(promptAt)),true);
  assert.equal(h.views.canCapture(session,Date.parse(rewardEndsAt)),true);
  assert.equal(h.views.canCapture(session,Date.parse(closesAt)-1),true);
  h.setNow(closesAt);h.events.visibilitychange();assert.equal(read(),Date.parse(closesAt));
  assert.equal(h.views.canCapture(session,Date.parse(closesAt)),false);
  for(const old of [{legacy:true},{scheduleVersion:2},{closed:true}])assert.equal(h.views.canCapture({...session,...old},Date.parse(rewardEndsAt)),false);
  h.setNow('2026-11-16T00:01Z');h.events.focus();assert.equal(read(),Date.parse('2026-11-16T00:01Z'));
});
test('Home keeps neutral capture after reward deadline and removes CTA only at midnight without refetch',()=>{
  const h=harness();const card=load('features/moments/MomentCard.tsx',{'react/jsx-runtime':h.mocks['react/jsx-runtime'],
    'react-router-dom':{Link:'Link',useNavigate:()=>()=>{}},'../../components/Icon':{Icon:'Icon'},'../questions/useCouplePeople':{useCouplePeople:()=>({partnerName:'Partner'})},'./MomentViews':h.views},h.globals);
  const props={moment:{...target,scheduleVersion:3,state:'open',windowEndsAt:rewardEndsAt,rewardEndsAt,closesAt,partnerPosted:false}};
  let tree=h.render(card.MomentCard,props);assert.equal(find(tree,n=>n.type===h.views.CaptureButton).props.label,'Chụp ngay');
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(card.MomentCard,props);
  const capture=find(tree,n=>n.type===h.views.CaptureButton);assert.equal(capture.props.label,'Chụp giữ chuỗi');assert.equal(capture.props.closesAt,closesAt);
  h.setNow(closesAt);h.events.focus();assert.equal(h.render(card.MomentCard,props),null);
  assert.equal(h.render(card.MomentCard,{moment:{...props.moment,scheduleVersion:2}}),null);
});
test('native camera capture is bound to original session and rejected after switch, cutoff, auth or lock',()=>{
  for(const kind of ['session','cutoff','account','lock']){
    const h=harness();let props={target,closesAt,rewardEndsAt,className:'button'};
    let tree=h.render(h.views.CaptureButton,props);find(tree,n=>n.type==='button').props.onClick();
    if(kind==='session'){props={...props,target:{...target,sessionId:'session-B'}};tree=h.render(h.views.CaptureButton,props);}
    if(kind==='cutoff')h.setNow(closesAt);if(kind==='account')h.switchAccount();if(kind==='access')h.changeAccess();if(kind==='lock')h.lock();
    find(tree,n=>n.type==='input').props.onChange({target:{files:[file],value:'photo'}});
    tree=h.render(h.views.CaptureButton,props);
    assert.equal(find(tree,n=>n.type===h.views.PostMomentSheet),undefined,kind);
  }
});
test('no-PIN camera resume preserves returned file across conceal and access epochs',()=>{
  const h=harness(),props={target,closesAt,rewardEndsAt,className:'button'};
  let tree=h.render(h.views.CaptureButton,props);find(tree,n=>n.type==='button').props.onClick();
  h.resume();find(tree,n=>n.type==='input').props.onChange({target:{files:[file],value:'photo'}});
  tree=h.render(h.views.CaptureButton,props);assert.ok(find(tree,n=>n.type===h.views.PostMomentSheet));
});
test('background during upload drops stale continuation but releases mounted no-PIN busy state',async()=>{
  const h=harness(),props={file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted(){throw Error('stale result');}};
  let tree=h.render(h.views.PostMomentSheet,props);find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});
  h.resume();h.upload.resolve({key:'key',width:10,height:10});await tick();
  tree=h.render(h.views.PostMomentSheet,props);
  assert.equal(find(tree,n=>n.type==='button'&&n.props.type==='submit').props.disabled,false);
  assert.equal(h.calls.post.length,0);assert.equal(h.calls.toast.length,0);
});
test('successful capture targets original session and preview is released on unmount',async()=>{
  const h=harness();const completed=[];
  const tree=h.render(h.views.PostMomentSheet,{file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted:d=>completed.push(d)});
  find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(h.calls.upload[0][1],target);
  h.upload.resolve({key:'session-key',width:10,height:10});await tick();
  assert.equal(h.calls.post[0].sessionId,'session-A');assert.equal(h.calls.post[0].localDate,target.localDate);
  h.post.resolve({localDate:target.localDate,sessions:[]});await tick();assert.equal(completed.length,1);assert.equal(h.calls.toast.length,1);
  h.unmount();assert.deepEqual(h.calls.revoked,['blob:mock']);
});
test('late upload/post completions cannot update replacement view or proceed after cutoff/lock',async()=>{
  for(const stage of ['upload','post']){
    const h=harness();let valid=true;const completed=[];
    const tree=h.render(h.views.PostMomentSheet,{file,target,rewardEndsAt,closesAt,valid:()=>valid,onRetake(){},onClose(){},onPosted:d=>completed.push(d)});
    find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});
    if(stage==='post'){h.upload.resolve({key:'key',width:1,height:1});await tick();assert.equal(h.calls.post.length,1);}
    valid=false;h.unmount();const states=h.calls.state.length;
    h.upload.resolve({key:'key',width:1,height:1});h.post.resolve({});await tick();
    assert.equal(h.calls.state.length,states);assert.equal(completed.length,0);assert.equal(h.calls.toast.length,0);assert.equal(h.calls.refresh.length,0);
    if(stage==='upload')assert.equal(h.calls.post.length,0);
  }
});
test('reward countdown becomes neutral at exact deadline, while capture stays available',()=>{
  const h=harness(),props={rewardEndsAt,closesAt};
  let tree=h.render(h.views.MomentTimer,props);assert.match(text(tree),/30:00.*40 Xu.*20 Xu/);
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(h.views.MomentTimer,props);
  assert.match(text(tree),/Đã hết thời gian nhận thưởng/);assert.equal(tree.props.role,'status');assert.equal(tree.props.className,'text-sm text-muted');
  h.setNow(closesAt);h.events.visibilitychange();assert.match(text(h.render(h.views.MomentTimer,props)),/Ngày chụp đã kết thúc/);
});
test('camera result and existing preview remain valid across reward deadline, but not midnight',()=>{
  const h=harness(),props={target,closesAt,rewardEndsAt,className:'button'};
  let tree=h.render(h.views.CaptureButton,props);find(tree,n=>n.type==='button').props.onClick();
  h.setNow(rewardEndsAt);h.events.focus();
  find(tree,n=>n.type==='input').props.onChange({target:{files:[file],value:'photo'}});
  tree=h.render(h.views.CaptureButton,props);const sheet=find(tree,n=>n.type===h.views.PostMomentSheet);
  assert.ok(sheet);assert.equal(sheet.props.valid(),true);
  h.setNow('2026-11-15T15:00Z');h.events.focus();tree=h.render(h.views.CaptureButton,props);
  assert.equal(find(tree,n=>n.type===h.views.PostMomentSheet).props.file,file);
  h.setNow(closesAt);h.events.focus();assert.equal(h.render(h.views.CaptureButton,props),null);assert.equal(sheet.props.valid(),false);
});
test('preview and submit survive upload through reward deadline; same-day late post completes',async()=>{
  const h=harness(),completed=[],props={file,target,rewardEndsAt,closesAt,valid:()=>h.globals.Date.now()<Date.parse(closesAt),onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
  let tree=h.render(h.views.PostMomentSheet,props);find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(h.views.PostMomentSheet,props);
  assert.ok(find(tree,n=>n.type==='img'));assert.deepEqual(h.calls.revoked,[]);assert.match(text(tree),/vẫn chụp được hôm nay/);
  h.upload.resolve({key:'late-key',width:1,height:1});await tick();assert.equal(h.calls.post.length,1);
  h.post.resolve({localDate:target.localDate,scheduleVersion:3,sessions:[]});await tick();assert.equal(completed.length,1);
  tree=h.render(h.views.PostMomentSheet,props);assert.equal(find(tree,n=>n.props.type==='submit').props.disabled,false);
  h.unmount();assert.deepEqual(h.calls.revoked,['blob:mock']);
});
test('timestamp eligibility is strict at both ends and ignores rounded lateness',()=>{
  assert.equal(helpers.isMomentPhotoOnTime(session,'2026-11-15T08:59:59.999Z'),false);
  assert.equal(helpers.isMomentPhotoOnTime(session,promptAt),true);
  assert.equal(helpers.isMomentPhotoOnTime(session,'2026-11-15T09:29:59.999Z'),true);
  assert.equal(helpers.isMomentPhotoOnTime(session,rewardEndsAt),false);
});
test('both on-time posts remain reward-eligible after deadline; late pair only preserves streak',()=>{
  const h=harness();h.setNow('2026-11-15T10:00Z');
  const onTime={postedAt:'2026-11-15T09:29:59.999Z',lateMin:0},late={postedAt:rewardEndsAt,lateMin:0};
  const paired={...session,state:'both',mine:onTime,partner:{posted:true,postedAt:onTime.postedAt,photo:onTime}};
  assert.match(text(h.render(h.views.MomentRewardStatus,{session:paired})),/Đủ điều kiện nhận tổng 40 Xu/);
  assert.match(text(h.render(h.views.MomentRewardStatus,{session:{...paired,mine:late}})),/không đủ điều kiện nhận 40 Xu/);
  assert.match(text(h.render(h.views.MomentPair,{day:{...paired,mine:late},partnerName:'Partner'})),/Sau hạn thưởng/);
  assert.equal(h.render(h.views.MomentRewardStatus,{session:{...paired,scheduleVersion:2}}),null);
});
test('v3 page uses one daily panel; old multi-session history/deep links remain read-only with existing Story links',()=>{
  const h=harness(),jsx=h.mocks['react/jsx-runtime'];
  const page=load('pages/MomentsPage.tsx',{
    react:h.mocks.react,'react/jsx-runtime':jsx,'react-router-dom':{Link:'Link'},
    '@tanstack/react-query':{useQueryClient:()=>({}),useMutation:()=>({isPending:false})},
    '../components/BottomSheet':{},'../components/GalleryViewer':{},'../components/Icon':{},'../components/StatusViews':{},
    '../components/Toast':{useToast:()=>({})},'../features/moments/api':{},'../features/moments/MomentViews':h.views,
    '../features/questions/useCouplePeople':{},'../features/stories/api':{},
    '../lib/apiClient':h.mocks['../../lib/apiClient'],'../lib/tokenStore':h.mocks['../../lib/tokenStore'],
    '../features/appLock/store':h.mocks['../appLock/store'],'../lib/format':{formatTime:String},
  },h.globals,['SessionPanel','DayPanel','StoryButton']);
  let tree=h.render(page.SessionPanel,{session,partnerName:'Partner',onOpenPhoto(){}});
  assert.match(text(tree),/Khoảnh khắc trong ngày/);assert.equal(find(tree,n=>n.type===h.views.CaptureButton).props.label,'Chụp ngay');
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(page.SessionPanel,{session,partnerName:'Partner',onOpenPhoto(){}});
  assert.equal(find(tree,n=>n.type===h.views.CaptureButton).props.label,'Chụp giữ chuỗi');
  const old={...session,scheduleVersion:2,closed:true,state:'both',storyId:'preserved-story'};
  assert.equal(find(h.render(page.SessionPanel,{session:old,partnerName:'Partner',onOpenPhoto(){}}),n=>n.type===h.views.CaptureButton),undefined);
  assert.equal(find(h.render(page.StoryButton,{session:old}),n=>n.type==='Link').props.to,'/stories/preserved-story');
  assert.equal(h.render(page.StoryButton,{session:{...old,storyId:null}}),null);
  const history={localDate:target.localDate,legacy:false,scheduleVersion:2,sessions:[old,{...old,sessionId:'second'},{...old,sessionId:'third'}]};
  const all=h.render(page.DayPanel,{day:history,partnerName:'Partner',onOpenPhoto(){}});
  const panels=all.props.children.at(-1);assert.equal(panels.length,3);
  const selected=h.render(page.DayPanel,{day:history,partnerName:'Partner',onOpenPhoto(){},selectedSession:'second'});
  assert.equal(selected.props.children.at(-1).length,1);assert.equal(selected.props.children.at(-1)[0].props.session.sessionId,'second');
});
test('upload pipeline checks session after compression, presign and PUT',async()=>{
  for(const stage of ['compress','presign','put']){
    let valid=true;const calls=[];const check=()=>{if(!valid)throw new Error('changed');};
    const api=load('features/moments/api.ts',{
      '../../lib/apiClient':{apiRequest:async(...args)=>{calls.push(args);if(stage==='presign')valid=false;return{uploadUrl:'mock',imageKey:'key'};}},
      '../../lib/image':{compressImageWithSize:async()=>{if(stage==='compress')valid=false;return{blob:{type:'image/jpeg',size:1},width:10,height:10};}},
      '../couple/api':{PULSE_KEY:['pulse']},'../quests/api':{QUESTS_KEY:['quests']},
    },{fetch:async()=>{if(stage==='put')valid=false;return{ok:true};}});
    await assert.rejects(api.uploadMomentPhoto(file,target,check),/changed/);
    if(stage==='compress')assert.equal(calls.length,0);else assert.equal(calls[0][1].body.sessionId,'session-A');
  }
});
