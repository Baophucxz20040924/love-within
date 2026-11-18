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
const transport=load('lib/apiClient.ts',{'./tokenStore':{}},{AbortController,DOMException,setTimeout,clearTimeout});
const helpers=load('features/moments/api.ts',{
  '../../lib/apiClient':transport,'../../lib/image':{},'../couple/api':{PULSE_KEY:['pulse']},'../quests/api':{QUESTS_KEY:['quests'],WALLET_KEY:['wallet'],LEDGER_KEY:['ledger']},
});
function text(node){if(Array.isArray(node))return node.map(text).join('');if(node?.props)return text(node.props.children);return node==null?'':String(node);}
function harness(){
  let now=Date.parse('2026-11-15T09:00Z'),generation='A',epoch=0,lock=0,discard=false,cursor=0;
  const cells=[],pendingEffects=[],cleanups=[],timers=[],events={},calls={post:[],upload:[],reconcile:[],cache:[],toast:[],refresh:[],revoked:[],state:[]};
  const upload=deferred(),post=deferred(),reconcile=deferred();
  class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
  class ApiError extends Error{constructor(status,code,message){super(message);this.code=code;this.status=status;}}
  const react={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;calls.state.push(i);}];},
    useRef(initial){const i=cursor++;return cells[i]??={current:initial};},
    useEffect(fn,deps){const i=cursor++;if(!(i in cells)||deps.some((d,n)=>d!==cells[i][n])){cells[i]=deps;pendingEffects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
  const jsx=(type,props,key)=>({type,props:props||{},key});
  const api={...helpers,cacheConfirmedMoment:(...a)=>calls.cache.push(a),uploadMomentPhoto:(...a)=>{calls.upload.push(a);return upload.promise;},momentsApi:{post:input=>{calls.post.push(input);return post.promise;},reconcile:input=>{calls.reconcile.push(input);return reconcile.promise;}},refreshMoments:async()=>calls.refresh.push(1),MAX_MOMENT_CAPTION:100};
  const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'@tanstack/react-query':{useQueryClient:()=>({}),useQuery:()=>({data:null})},
    '../../components/BottomSheet':{BottomSheet:'Sheet'},'../../components/Icon':{Icon:'Icon'},'../../components/Toast':{useToast:()=>({success:s=>calls.toast.push(s),error:s=>calls.toast.push(s)})},
    '../../lib/apiClient':{ApiRequestError:ApiError,currentAccessEpoch:()=>epoch},'../../lib/format':{formatTime:String},
    '../../lib/tokenStore':{tokenStore:{generation:()=>generation,isCurrent:g=>g===generation}},'../appLock/store':{appLockEpoch:()=>lock,appLockState:()=>({discard}),isAppLocked:()=>discard},'./api':api};
  const win={setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},addEventListener:(name,fn)=>events[name]=fn,removeEventListener(){}};
  const globals={Date:Clock,AbortController,window:win,document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name]=fn,removeEventListener(){}},URL:{createObjectURL:()=> 'blob:mock',revokeObjectURL:url=>calls.revoked.push(url)}};
  const views=load('features/moments/MomentViews.tsx',mocks,globals);
  const render=(fn,props)=>{cursor=0;const tree=fn(props);while(pendingEffects.length)pendingEffects.shift()();return tree;};
  return{views,render,cells,calls,upload,post,reconcile,timers,events,mocks,globals,unmount:()=>cleanups.forEach(fn=>fn?.()),setNow:v=>now=+new Date(v),switchAccount:()=>generation='B',changeAccess:()=>epoch++,resume:()=>{lock++;epoch++;},lock:()=>{lock++;discard=true;}};
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
  h.setNow(closesAt);h.events.focus();tree=h.render(card.MomentCard,props);assert.equal(find(tree,n=>n.type===h.views.CaptureButton).props.available,false);
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
  h.post.resolve({...target,saved:true,postedAt:promptAt});await tick();assert.equal(completed.length,1);assert.equal(h.calls.toast.length,1);
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
  const h=harness(),props={rewardEndsAt,closesAt,reward:{policyVersion:1}};
  let tree=h.render(h.views.MomentTimer,props);assert.match(text(tree),/30:00.*40 Xu.*20 Xu/);
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(h.views.MomentTimer,props);
  assert.match(text(tree),/Đã hết thời gian nhận thưởng/);assert.equal(tree.props.role,'status');assert.equal(tree.props.className,'text-sm text-muted');
  h.setNow(closesAt);h.events.visibilitychange();assert.match(text(h.render(h.views.MomentTimer,props)),/Ngày chụp đã kết thúc/);
});
test('existing preview survives midnight for reconciliation, but the capture button closes',()=>{
  const h=harness(),props={target,closesAt,rewardEndsAt,className:'button'};
  let tree=h.render(h.views.CaptureButton,props);find(tree,n=>n.type==='button').props.onClick();
  h.setNow(rewardEndsAt);h.events.focus();
  find(tree,n=>n.type==='input').props.onChange({target:{files:[file],value:'photo'}});
  tree=h.render(h.views.CaptureButton,props);const sheet=find(tree,n=>n.type===h.views.PostMomentSheet);
  assert.ok(sheet);assert.equal(sheet.props.valid(),true);
  h.setNow('2026-11-15T15:00Z');h.events.focus();tree=h.render(h.views.CaptureButton,props);
  assert.equal(find(tree,n=>n.type===h.views.PostMomentSheet).props.file,file);
  h.setNow(closesAt);h.events.focus();tree=h.render(h.views.CaptureButton,props);assert.ok(find(tree,n=>n.type===h.views.PostMomentSheet));assert.equal(find(tree,n=>n.type==='button'),undefined);assert.equal(sheet.props.valid(),true);
});
test('preview and submit survive upload through reward deadline; same-day late post completes',async()=>{
  const h=harness(),completed=[],props={file,target,rewardEndsAt,closesAt,valid:()=>h.globals.Date.now()<Date.parse(closesAt),onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
  let tree=h.render(h.views.PostMomentSheet,props);find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(h.views.PostMomentSheet,props);
  assert.ok(find(tree,n=>n.type==='img'));assert.deepEqual(h.calls.revoked,[]);assert.match(text(tree),/vẫn chụp được hôm nay/);
  h.upload.resolve({key:'late-key',width:1,height:1});await tick();assert.equal(h.calls.post.length,1);
  h.post.resolve({...target,saved:true,postedAt:rewardEndsAt});await tick();assert.equal(completed.length,1);
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
  assert.match(text(h.render(h.views.MomentRewardStatus,{session:paired,reward:{policyVersion:1}})),/Đủ điều kiện nhận tổng 40 Xu/);
  assert.match(text(h.render(h.views.MomentRewardStatus,{session:{...paired,mine:late},reward:{policyVersion:1}})),/không đủ điều kiện nhận 40 Xu/);
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
  assert.notEqual(find(tree,n=>n.type===h.views.CaptureButton).key,find(tree,n=>n.type===page.StoryButton).key);
  h.setNow(rewardEndsAt);h.events.focus();tree=h.render(page.SessionPanel,{session,partnerName:'Partner',onOpenPhoto(){}});
  assert.equal(find(tree,n=>n.type===h.views.CaptureButton).props.label,'Chụp hôm nay');
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
test('new-policy rewards separate automatic base, pair bonus, pending receipt and EXP; unknown policy stays neutral',()=>{
  const h=harness();
  const reward={policyVersion:2,effectiveDate:target.localDate,localDate:target.localDate,status:'pending',baseCoin:10,bonusCoin:10,coinAwarded:10,commonStreak:null};
  const saved={...session,mine:{postedAt:promptAt}};
  let copy=text(h.render(h.views.MomentRewardStatus,{session:saved,reward}));
  assert.match(copy,/Đang xử lý thưởng; đã nhận 10 Xu/);assert.match(copy,/chỉ nhận 5 EXP/);assert.doesNotMatch(copy,/40 Xu|Đã nhận 20/);
  copy=text(h.render(h.views.MomentRewardStatus,{session:saved,reward:{...reward,status:'awarded',bonusCoin:0}}));
  assert.match(copy,/Đã nhận 10 Xu của bạn \(10 cơ bản \+ 0 thưởng/);
  h.setNow(rewardEndsAt);h.events.focus();
  copy=text(h.render(h.views.MomentTimer,{rewardEndsAt,closesAt,reward}));assert.match(copy,/ảnh đầu ngày vẫn nhận 10 Xu/);
  assert.doesNotMatch(text(h.render(h.views.MomentTimer,{rewardEndsAt,closesAt})),/40 Xu|20 Xu|10 Xu/);
});
test('confirmed POST closes and caches immediately even if background refetch never settles or rejects',async()=>{
  for(const failure of ['hang','reject']){
    const h=harness(),completed=[];
    h.mocks['./api'].refreshMoments=()=>failure==='hang'?new Promise(()=>{}):Promise.reject(Error('refetch failed'));
    const props={file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
    find(h.render(h.views.PostMomentSheet,props),n=>n.type==='form').props.onSubmit({preventDefault(){}});
    h.upload.resolve({key:'retained',width:1,height:1});await tick();
    h.post.resolve({...target,saved:true,postedAt:promptAt});await tick();
    assert.equal(completed.length,1);assert.equal(h.calls.cache.length,1);
    assert.equal(find(h.render(h.views.PostMomentSheet,props),n=>n.props.type==='submit').props.disabled,false);
    h.unmount();
  }
});
test('lost POST response checks original day after midnight; check again retains upload and never reposts',async()=>{
  const h=harness(),completed=[];
  const props={file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
  const submit=()=>find(h.render(h.views.PostMomentSheet,props),n=>n.type==='form').props.onSubmit({preventDefault(){}});
  submit();h.upload.resolve({key:'retained',width:1,height:1});await tick();
  h.setNow(closesAt);h.post.reject(Error('response lost'));await tick();
  assert.equal(h.calls.reconcile[0],target);h.reconcile.resolve(null);await tick();
  let tree=h.render(h.views.PostMomentSheet,props);assert.match(text(tree),/Kiểm tra lại/);assert.match(text(tree),/Ảnh tải lên vẫn được giữ/);
  assert.equal(find(tree,n=>n.props.type==='submit').props.disabled,false);
  const saved={localDate:target.localDate,sessions:[{...session,mine:{postedAt:promptAt}}]};
  h.mocks['./api'].momentsApi.reconcile=async input=>{h.calls.reconcile.push(input);return saved;};
  submit();await tick();assert.equal(completed[0],saved);assert.equal(h.calls.post.length,1);assert.equal(h.calls.upload.length,1);
});
test('409 already posted reconciles instead of showing failure or sending another POST',async()=>{
  const h=harness(),completed=[];
  const props={file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
  find(h.render(h.views.PostMomentSheet,props),n=>n.type==='form').props.onSubmit({preventDefault(){}});
  h.upload.resolve({key:'retained',width:1,height:1});await tick();
  h.post.reject(new transport.ApiRequestError(409,'MOMENT_ALREADY_POSTED','already'));await tick();
  h.reconcile.resolve({localDate:target.localDate,sessions:[{...session,mine:{postedAt:promptAt}}]});await tick();
  assert.equal(completed.length,1);assert.equal(h.calls.post.length,1);assert.equal(h.calls.toast.length,1);
});
test('stale POST and reconciliation completions never apply across account, PIN, visibility, epoch or unmount',async()=>{
  for(const stage of ['post','reconcile'])for(const change of ['account','pin','hidden','epoch','unmount']){
    const h=harness(),completed=[];
    const props={file,target,rewardEndsAt,closesAt,valid:()=>true,onRetake(){},onClose(){},onPosted:d=>completed.push(d)};
    const submit=()=>find(h.render(h.views.PostMomentSheet,props),n=>n.type==='form').props.onSubmit({preventDefault(){}});
    submit();h.upload.resolve({key:'retained',width:1,height:1});await tick();
    if(stage==='reconcile'){h.post.reject(Error('lost'));await tick();}
    if(change==='account')h.switchAccount();if(change==='pin')h.lock();if(change==='hidden')h.globals.document.visibilityState='hidden';if(change==='epoch')h.changeAccess();if(change==='unmount')h.unmount();
    h.post.resolve({...target,saved:true,postedAt:promptAt});h.reconcile.resolve({localDate:target.localDate,sessions:[{...session,mine:{postedAt:promptAt}}]});await tick();
    assert.equal(completed.length,0,`${stage}/${change}`);assert.equal(h.calls.cache.length,0);assert.equal(h.calls.toast.length,0);assert.equal(h.calls.refresh.length,0);
    if(stage==='post' && ['hidden','epoch'].includes(change)){
      h.globals.document.visibilityState='visible';submit();await tick();assert.equal(h.calls.post.length,1);assert.equal(h.calls.reconcile.length,1);
    }
  }
});
test('snapshot cache updates exact date/session without replacing new today or downgrading partner state',()=>{
  const data=new Map(),key=k=>JSON.stringify(k),qc={setQueryData(k,value){const old=data.get(key(k));const next=typeof value==='function'?value(old):value;if(next!==undefined)data.set(key(k),next);}};
  const oldSession={...session,state:'both',mine:{postedAt:promptAt},partner:{posted:true,photo:{url:'already-visible'},postedAt:promptAt}};
  const oldDay={localDate:target.localDate,sessions:[oldSession,{...session,sessionId:'other'}]};
  const tomorrow={localDate:'2026-11-16',sessions:[]};
  data.set(key(helpers.MOMENT_TODAY_KEY),tomorrow);
  data.set(key(helpers.momentMonthKey('2026-11')),{month:'2026-11',days:[oldDay],streak:{current:2}});
  const result={localDate:target.localDate,sessions:[{...session,state:'posted',mine:{postedAt:promptAt}}]};
  helpers.cacheConfirmedMoment(qc,target,result);
  assert.equal(data.get(key(helpers.MOMENT_TODAY_KEY)),tomorrow);
  const updated=data.get(key(helpers.momentMonthKey('2026-11'))).days[0];
  assert.equal(updated.sessions[0].partner.photo.url,'already-visible');assert.equal(updated.sessions[1].sessionId,'other');
  assert.equal(data.get(key(helpers.momentReceiptKey(target))).saved,true);
  const size=data.size;helpers.cacheConfirmedMoment(qc,target,{...target,sessionId:'wrong',saved:true,postedAt:promptAt});assert.equal(data.size,size);
});
test('exact receipt hides recapture and shows saved while signed view hangs, without inventing photos or coins',()=>{
  const h=harness(),receipt={...target,saved:true,postedAt:promptAt};
  const observe=options=>{
    assert.equal(options.enabled,false);assert.equal(options.queryFn(),null);
    assert.equal(JSON.stringify(options.queryKey),JSON.stringify(helpers.momentReceiptKey(target)));
    return{data:receipt};
  };
  h.mocks['@tanstack/react-query'].useQuery=observe;
  assert.equal(h.render(h.views.CaptureButton,{target,closesAt,rewardEndsAt,className:'button'}),null);
  const reward={policyVersion:2,status:'waiting',coinAwarded:0};
  const status=harness();status.mocks['@tanstack/react-query'].useQuery=observe;
  const copy=text(status.render(status.views.MomentRewardStatus,{session,reward}));
  assert.match(copy,/Ảnh đã lưu.*không cần đăng lại/);assert.doesNotMatch(copy,/Bạn chưa đăng|Đã nhận/);
  const pair=harness();pair.mocks['@tanstack/react-query'].useQuery=observe;
  const tree=pair.render(pair.views.MomentPair,{day:{...session,partner:{posted:true,photo:null}},partnerName:'Partner'});
  assert.match(text(tree),/Ảnh đã lưu · đang cập nhật/);assert.doesNotMatch(text(tree),/Bạn chưa chụp|Chụp hôm nay để xem/);
  assert.equal(find(tree,n=>n.type==='img'),undefined);
  receipt.sessionId='foreign';
  assert.ok(find(h.render(h.views.CaptureButton,{target,closesAt,rewardEndsAt,className:'button'}),n=>n.type==='button'));
});
test('background invalidation is finite, deduplicated and catches failures including wallet/ledger',async()=>{
  const calls=[];
  await helpers.refreshMoments({invalidateQueries({queryKey}){calls.push(JSON.stringify(queryKey));return Promise.reject(Error('offline'));}},target);
  assert.equal(new Set(calls).size,calls.length);
  assert.deepEqual(calls,['["moments","month","2026-11"]','["moments","today"]','["pulse"]','["quests"]','["wallet"]','["ledger"]']);
});
test('pending draft notifications use current callback without rerender loops, and clear on dismissal',()=>{
  const h=harness(),calls=[];let props={target,closesAt,rewardEndsAt,className:'button',onPendingChange:v=>calls.push(['first',v])};
  let tree=h.render(h.views.CaptureButton,props);assert.deepEqual(calls,[['first',false]]);
  props={...props,onPendingChange:v=>calls.push(['latest',v])};tree=h.render(h.views.CaptureButton,props);assert.equal(calls.length,1);
  find(tree,n=>n.type==='button').props.onClick();find(tree,n=>n.type==='input').props.onChange({target:{files:[file],value:'photo'}});
  tree=h.render(h.views.CaptureButton,props);assert.deepEqual(calls.at(-1),['latest',true]);
  find(tree,n=>n.type===h.views.PostMomentSheet).props.onClose();h.render(h.views.CaptureButton,props);assert.deepEqual(calls.at(-1),['latest',false]);
});
test('history reconciliation uses original month, exact date/session and authenticated mine, never partner alone',async()=>{
  let response,calls=[];
  const api=load('features/moments/api.ts',{'../../lib/apiClient':{...transport,apiRequest:async(...args)=>{calls.push(args);return response;}},'../../lib/image':{},'../couple/api':{},'../quests/api':{}});
  for(const candidate of [{...session,mine:null,partner:{posted:true}},{...session,sessionId:'wrong',mine:{}},{...session,localDate:'2026-11-16',mine:{}}]){
    response={days:[{localDate:target.localDate,sessions:[candidate]}]};assert.equal(await api.momentsApi.reconcile(target),null);
  }
  const day={localDate:target.localDate,sessions:[{...session,mine:{postedAt:promptAt}}]};response={days:[day]};assert.equal(await api.momentsApi.reconcile(target),day);
  assert.equal(calls[0][0],'/moments?month=2026-11');assert.equal(calls[0][1].timeoutMs,15000);
});
test('upload pipeline checks session after compression, presign and PUT',async()=>{
  for(const stage of ['compress','presign','put']){
    let valid=true;const calls=[];const check=()=>{if(!valid)throw new Error('changed');};
    const api=load('features/moments/api.ts',{
      '../../lib/apiClient':{...transport,apiRequest:async(...args)=>{calls.push(args);if(stage==='presign')valid=false;return{uploadUrl:'mock',imageKey:'key'};}},
      '../../lib/image':{compressImageWithSize:async()=>{if(stage==='compress')valid=false;return{blob:{type:'image/jpeg',size:1},width:10,height:10};}},
      '../couple/api':{PULSE_KEY:['pulse']},'../quests/api':{QUESTS_KEY:['quests'],WALLET_KEY:['wallet'],LEDGER_KEY:['ledger']},
    },{fetch:async()=>{if(stage==='put')valid=false;return{ok:true};}});
    await assert.rejects(api.uploadMomentPhoto(file,target,check),/changed/);
    if(stage==='compress')assert.equal(calls.length,0);else assert.equal(calls[0][1].body.sessionId,'session-A');
  }
});
