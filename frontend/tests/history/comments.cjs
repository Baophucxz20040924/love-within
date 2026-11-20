'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file,mocks){const filename=path.resolve(__dirname,'../../src',file),module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,requestAnimationFrame:fn=>fn(),require(name){assert.ok(Object.hasOwn(mocks,name),`Unexpected import ${name}`);return mocks[name];}},{filename});return module.exports;}
let states=[],refs=[],si,ri,mi,tree,query,mutations=[],invalidations=[];
let result={isSuccess:true,data:{items:[{id:'2',body:'second',author:{id:'u',displayName:'U'}},{id:'1',body:'first',author:{id:'u',displayName:'U'}}],nextCursor:'older'}};
const jsx=(type,props)=>({type,props});
const api={commentsPage:async()=>{},addComment:async()=>{},deleteComment:async()=>{}};
let draftText = '';
const draftHook = { useCommentDraft: () => ({ ready: true, text: draftText, setText: text => { draftText = text; }, snapshot: () => ({ text: draftText }), clear: () => { draftText = ''; }, discard: () => { draftText = ''; } }), useCommentDraftDenial() {} };
const {CommentSection}=load('features/stories/Comments.tsx',{
 '../../hooks/useCommentDraft': draftHook,
 react:{useState(v){const i=si++;if(!(i in states))states[i]=v;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},useRef(v){return refs[ri++]??={current:v};},useEffect(){},useId:()=> 'form'},
 'react/jsx-runtime':{jsx,jsxs:jsx},'../stories/form-interactions.css':{},
 '@tanstack/react-query':{useQuery:o=>{query=o;return{isFetching:false,...result};},useQueryClient:()=>({invalidateQueries:async o=>invalidations.push(o),setQueryData:()=>assert.fail('No array cache overlay')}),useMutation:o=>{const i=mi++;mutations[i]=o;return{...o,isPending:false,isError:false,mutate(){}};}},
 '../../components/Avatar':{Avatar:'Avatar'},'../../components/BottomSheet':{BottomSheet:'BottomSheet'},'../../components/Icon':{Icon:'Icon'},'../../components/StatusViews':{Skeleton:'Skeleton'},'../../components/Toast':{useToast:()=>({info(){},error(){}})},
 '../auth/AuthContext':{useAuth:()=>({me:{user:{id:'u'},couple:{id:'c'}}})},'../auth/useAvatarOf':{useAvatarOf:()=>()=>null},'../../lib/apiClient':{ApiRequestError:Error},'../../lib/format':{timeAgo:()=>''},'./api':{storiesApi:api,storyCommentsKey:id=>['stories','comments',id]},'./cache':{updateStoryInCache(){}},
});
function render(){si=ri=mi=0;tree=CommentSection({storyId:'story',focusKey:0});}
function nodes(n=tree){return !n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).filter(v=>v!==undefined).flatMap(nodes)];}
function button(text){return nodes().find(n=>n.type==='button'&&n.props.children===text);}
render();assert.equal(query.refetchInterval,20000);assert.equal(query.refetchOnWindowFocus,true);
assert.deepEqual(nodes().filter(n=>n.props?.className==='comment__body').map(n=>n.props.children),['first','second']);
button('Bình luận cũ hơn').props.onClick();render();assert.equal(query.queryKey.at(-1),'older');
const input=nodes().find(n=>n.type==='textarea');input.props.onChange({target:{value:'draft',style:{},scrollHeight:20}});render();
mutations[0].onError();render();assert.equal(nodes().find(n=>n.type==='textarea').props.value,'draft');
result={isSuccess:true,data:{items:[],nextCursor:null}};render();assert.ok(button('Mới nhất'));
nodes().find(n=>n.type==='form').props.onSubmit({preventDefault(){}}); mutations[0].onSuccess();render();assert.equal(query.queryKey.at(-1),null);assert.equal(nodes().find(n=>n.type==='textarea').props.value,'');
assert.equal(invalidations[0].refetchType,'active');
result={isError:true,data:{items:[{id:'secret',body:'private',author:{}}]}};render();assert.equal(nodes().filter(n=>n.props?.className==='comment__body').length,0);
const calls=[];const wrapper=load('features/stories/api.ts',{'../../lib/apiClient':{apiRequest:(...a)=>calls.push(a)},'../../lib/image':{}});
const signal=new AbortController().signal;wrapper.storiesApi.commentsPage('story','older',signal);assert.equal(calls[0][1].signal,signal);assert.equal(calls[0][0],'/stories/story/comments/page?limit=20&cursor=older');
console.log('PASS comments UI: chronological active page, history/newest, draft failure retention, success invalidation, private error hiding and signal');
