'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
function load(file, mocks) {
  const filename = path.resolve(__dirname, '../../src', file), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, requestAnimationFrame: () => 1, require(name) { assert.ok(Object.hasOwn(mocks,name), `Unexpected ${name}`); return mocks[name]; } }, { filename });
  return module.exports;
}
const calls = [], signal = new AbortController().signal;
const wrappers = load('features/friends/api.ts', { '../../lib/apiClient': { apiRequest: (...args) => calls.push(args) }, '../../lib/image': {} });
for (const [api, resource] of [[wrappers.friendStoriesApi,'stories'], [wrappers.friendEventsApi,'events']]) {
  api.commentsPage('a/b','x y',signal); api.repliesPage('a/b','r/x','z',signal); api.commentContext('a/b','t/x',signal);
  assert.equal(calls.at(-3)[0], `/friends/${resource}/a%2Fb/comments/page?limit=20&cursor=x%20y`);
  assert.equal(calls.at(-2)[0], `/friends/${resource}/a%2Fb/comments/r%2Fx/replies/page?limit=20&cursor=z`);
  assert.equal(calls.at(-1)[0], `/friends/${resource}/a%2Fb/comments/t%2Fx/context`);
  assert.ok(calls.slice(-3).every(c => c[1].signal === signal));
}
let states=[],refs=[],si,ri,mi,tree,queries=[],mutations=[],invalidations=[];
const root = { id:'root',body:'root text',author:{id:'u',displayName:'U'},mentions:[],parentId:null };
let rootResult={isSuccess:true,data:{items:[root],nextCursor:'older'}},contextResult={};
const jsx=(type,props)=>({type,props});
const exportsUI=load('features/friends/FriendComments.tsx', {
  react:{useState(v){const i=si++;if(!(i in states))states[i]=typeof v==='function'?v():v;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(v){return refs[ri++]??={current:v};},useEffect(){},useId:()=> 'form'},
  'react/jsx-runtime':{jsx,jsxs:jsx},'../stories/form-interactions.css':{}, 'react-router-dom':{Link:'Link'},
  '@tanstack/react-query':{useQuery:o=>{queries.push(o);return {isFetching:false,...(o.queryKey.includes('context')?contextResult:rootResult)};},useQueryClient:()=>({invalidateQueries:async o=>invalidations.push(o),setQueryData:()=>assert.fail('No full-array overlay')}),useMutation:o=>{mutations[mi++]=o;return{...o,isPending:false,isError:false,mutate(){}};}},
  '../../components/Avatar':{Avatar:'Avatar'},'../../components/BottomSheet':{BottomSheet:'BottomSheet'},'../../components/Icon':{Icon:'Icon'},'../../components/StatusViews':{Skeleton:'Skeleton'},'../../components/Toast':{useToast:()=>({info(){},error(){}})},
  '../auth/AuthContext':{useAuth:()=>({me:{user:{id:'u'}}})},'../../lib/apiClient':{ApiRequestError:Error},'../../lib/format':{timeAgo:()=>''},
  './api':wrappers,'./cache':{},'./MentionField':{MentionField:'MentionField'},'./mentions':{segments:()=>[],toPayload:(text)=>({body:text}),prefillMention:()=>assert.fail('unexpected mention')},'./SafetySheets':{BlockSheet:'BlockSheet',ReportSheet:'ReportSheet'},
});
const api={key:['friends','comments','story'],rootsPage(){},repliesPage(){},context(){},add(){},remove(){},onCount(){}};
// Render the scoped component returned by the account/resource keyed boundary.
function render(){si=ri=mi=0;queries=[];const boundary=exportsUI.FriendComments({api,focusKey:0});tree=boundary.type(boundary.props);}
function nodes(n=tree){return !n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).filter(v=>v!==undefined).flatMap(nodes)];}
render();assert.equal(queries[0].refetchInterval,20000);assert.equal(queries[0].enabled,true);assert.equal(queries[1].enabled,false);
const nav=nodes().find(n=>typeof n.type==='function'&&n.type.name==='PageNav');nav.props.older();render();assert.equal(queries[0].queryKey.at(-1),'older');
const input=nodes().find(n=>n.type==='MentionField');input.props.onChange('draft',[]);render();mutations[0].onError();render();assert.equal(nodes().find(n=>n.type==='MentionField').props.text,'draft');
mutations[0].onSuccess({...root,id:'new'});render();assert.equal(queries[0].queryKey.at(-1),null);assert.equal(nodes().find(n=>n.type==='MentionField').props.text,'');assert.equal(invalidations[0].refetchType,'active');
mutations[0].onSuccess({...root,id:'reply',parentId:'root'});contextResult={isSuccess:true,data:{root,replies:{items:[],nextCursor:null}}};render();assert.equal(queries[0].enabled,false);assert.equal(queries[1].enabled,true);assert.equal(queries[1].queryKey.at(-1),'root');
const replyComponent=nodes().find(n=>typeof n.type==='function'&&n.type.name==='Replies');
nodes().find(n=>n.type==='ReportSheet').props.onBlock(root.author);render();nodes().find(n=>n.type==='BlockSheet').props.onBlocked();render();assert.equal(nodes().filter(n=>typeof n.type==='function'&&n.type.name==='CommentItem').length,0,'Successful local block immediately hides cached root before refetch');
contextResult={isError:true,data:{root,replies:{items:[],nextCursor:null}}};render();assert.equal(nodes().filter(n=>typeof n.type==='function'&&n.type.name==='CommentItem').length,0);
// A notification page is a distinct history position. Back must restore it, not newest.
states=[];refs=[];
const replyProps={...replyComponent.props,seed:{items:[{...root,id:'target'}],nextCursor:'reply-older'},render:c=>jsx('row',{id:c.id})};
function renderReplies(){si=ri=0;queries=[];tree=replyComponent.type(replyProps);}
const replyNav=()=>nodes().find(n=>typeof n.type==='function'&&n.type.name==='PageNav');
renderReplies();assert.equal(queries[0].enabled,false);assert(nodes().some(n=>n.type==='row'&&n.props.id==='target'));
replyNav().props.older();renderReplies();assert.equal(queries[0].queryKey.at(-1),'reply-older');assert.equal(queries[0].enabled,true);
replyNav().props.newer();renderReplies();assert.equal(queries[0].enabled,false);assert(nodes().some(n=>n.type==='row'&&n.props.id==='target'));
replyNav().props.newest();renderReplies();assert.equal(queries[0].enabled,true);assert.equal(queries[0].queryKey.at(-1),null);assert.equal(queries[0].refetchInterval,undefined);assert(!nodes().some(n=>n.type==='row'&&n.props.id==='target'));
console.log('PASS Friends comments: both signal wrappers, scoped keys, single poll mode, history, failed draft, success navigation and stale context hiding');
