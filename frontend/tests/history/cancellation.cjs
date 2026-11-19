'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {QueryClient,QueryObserver,InfiniteQueryObserver}=require('@tanstack/query-core');
function load(file,mocks,globals={}){const filename=path.resolve(__dirname,'../../src',file),module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Error,Promise,Headers,AbortController,DOMException,URLSearchParams,setTimeout,clearTimeout,...globals,require(name){assert.ok(Object.hasOwn(mocks,name),`Unexpected import ${name}`);return mocks[name];}},{filename});return module.exports;}
const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const calls=[];
const api=load('lib/apiClient.ts',{'./tokenStore':{tokenStore:{generation:()=> 'A',isCurrent:g=>g==='A',get:()=>({accessToken:'access'}),clear(){throw Error('unexpected logout');}}}},
 {fetch:(url,init)=>{const d=pending();calls.push({url,init,...d});return d.promise;}});
const stories=load('features/stories/api.ts',{'../../lib/apiClient':api,'../../lib/image':{}}).storiesApi;
const friends=load('features/friends/api.ts',{'../../lib/apiClient':api,'../../lib/image':{}}).friendStoriesApi;
const outings=load('features/friends/outings/api.ts',{'../../../lib/apiClient':api}).outingsApi;
(async()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 const options={queryKey:['friends','story','one'],queryFn:({signal})=>friends.get('one',signal)};
 const a=new QueryObserver(qc,options),b=new QueryObserver(qc,options);
 const offA=a.subscribe(()=>{}),offB=b.subscribe(()=>{});await tick();assert.equal(calls.length,1);
 offA();assert.equal(calls[0].init.signal.aborted,false,'another observer owns read');
 offB();assert.equal(calls[0].init.signal.aborted,true,'last observer cancels read');
 calls[0].resolve({status:200,ok:true,json:async()=>({data:'late private'})});await tick();
 assert.notEqual(qc.getQueryData(options.queryKey),'late private');
 const detail=new QueryObserver(qc,{queryKey:['stories','detail','one'],queryFn:({signal})=>stories.get('one',signal)});
 const off=detail.subscribe(()=>{});await tick();const old=calls.at(-1);
 detail.setOptions({queryKey:['stories','detail','two'],queryFn:({signal})=>stories.get('two',signal)});await tick();
 assert.equal(old.init.signal.aborted,true);assert.equal(calls.at(-1).url,'/api/stories/two');off();
 const feed=new InfiniteQueryObserver(qc,{queryKey:['friends','outings'],queryFn:({pageParam,signal})=>outings.list(pageParam,signal),initialPageParam:undefined,getNextPageParam:p=>p.nextCursor});
 const stop=feed.subscribe(()=>{});await tick();calls.at(-1).resolve({status:200,ok:true,json:async()=>({data:{items:[],nextCursor:'next'}})});await tick();
 const next=feed.fetchNextPage();await tick();const request=calls.at(-1);assert.ok(request.url.includes('cursor=next'));stop();await next;assert.equal(request.init.signal.aborted,true);
 for(const call of [()=>outings.forEvent('event',new AbortController().signal),()=>outings.get('id',new AbortController().signal),()=>friends.feed(undefined,new AbortController().signal),()=>stories.feed(undefined,new AbortController().signal)]){void call();assert.ok(calls.at(-1).init.signal instanceof AbortSignal);}
 qc.clear();
 console.log('PASS query cancellation: shared observers, last unsubscribe, changed parameter, cancelled next page and selected wrapper signals');
})().catch(e=>{console.error(e);process.exitCode=1;});
