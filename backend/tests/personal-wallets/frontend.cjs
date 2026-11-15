'use strict';
// Tests the real frontend request identity helper without a browser or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../../frontend/src/features/market/api.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const values = new Map(); let sequence = 0, request;
const storage = {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
function load(sessionStorage=storage) {
  const mod={exports:{}};
  vm.runInNewContext(code,{module:mod,exports:mod.exports,sessionStorage,crypto:{randomUUID:()=>`request-${++sequence}`},require(name){assert.equal(name,'../../lib/apiClient');return{apiRequest:(url,options)=>{request={url,options};}};}});
  return mod.exports;
}
let api=load();const a=api.marketRequestKey('user-a:couple-a:item');assert.equal(api.marketRequestKey('user-a:couple-a:item'),a);
api=load();assert.equal(api.marketRequestKey('user-a:couple-a:item'),a,'reload resumes uncertain operation');
assert.notEqual(api.marketRequestKey('user-b:couple-a:item'),a,'account scoped');assert.notEqual(api.marketRequestKey('user-a:couple-b:item'),a,'couple scoped');
assert.equal(api.isRecoveredRedemption('requested'),false);
for(const status of ['accepted','fulfilled','declined','cancelled','refunding']) assert.equal(api.isRecoveredRedemption(status),true,'replay must not claim new request');
api.marketApi.request('item',a);assert.equal(request.options.body.requestKey,a);
api.clearMarketRequestKey('user-a:couple-a:item');assert.notEqual(api.marketRequestKey('user-a:couple-a:item'),a,'confirmed terminal permits new intentional request');
api=load({getItem(){throw Error('disabled');},setItem(){throw Error('disabled');},removeItem(){throw Error('disabled');}});
const fallback=api.marketRequestKey('fallback');assert.equal(api.marketRequestKey('fallback'),fallback);api.clearMarketRequestKey('fallback');
const card=fs.readFileSync(path.resolve(__dirname,'../../../frontend/src/components/WalletCard.tsx'),'utf8');assert.match(card,/Ví Xu của bạn/);
const profile=fs.readFileSync(path.resolve(__dirname,'../../../frontend/src/pages/ProfilePage.tsx'),'utf8');assert.match(profile,/Ví chung trước chuyển đổi/);
console.log('PASS frontend wallet labels and scoped stable market request keys across retry/reload');
