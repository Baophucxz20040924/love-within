'use strict';
// Actual store with per-tab synthetic storage; no browser, network or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), { randomUUID } = require('node:crypto');
const filename = path.resolve(__dirname, '../../src/lib/commentDraftStore.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let generation = 'login-a', now = Date.now(), failStorage = false;
const storage = new Map();
function load() {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, crypto: { randomUUID }, Date: class extends Date { static now() { return now; } },
    sessionStorage: { getItem: key => { if (failStorage) throw Error('disabled'); return storage.get(key); }, setItem: (key, value) => { if (failStorage) throw Error('quota'); storage.set(key, value); } },
    require: name => { assert.equal(name, './tokenStore'); return { tokenStore: { isCurrent: g => g === generation } }; } }, { filename });
  return module.exports.commentDraftStore;
}
const scope = { generation, userId: 'user-a', space: 'friends', coupleId: '', kind: 'story', resourceId: 'post-a' };
let store = load(), handle = store.open(scope);
const first = store.write(handle, 'nháp có dấu @Tên', 'root-a');
assert.equal(store.read(handle).rootId, 'root-a');
store = load(); handle = store.open(scope);
assert.equal(store.read(handle).text, first.text, 'reload restores plain text and exact reply target');
const second = store.write(handle, first.text, 'root-a');
assert.notEqual(first.revision, second.revision);
assert.equal(store.clear(handle, first), false, 'late success cannot clear same-text newer edit');
assert.equal(store.clear(handle, second), true);
assert.equal(store.write(handle, 'stale callback', null), undefined, 'discard fences old handle');
handle = store.open(scope); store.write(handle, 'private', null); store.revoke(scope);
assert.equal(store.read(handle), undefined); assert.equal(store.write(handle, 'resurrect', null), undefined);
handle = store.open(scope); store.write(handle, 'x'.repeat(3000), null);
assert.equal(store.read(handle).text.length, 2000);
const other = store.open({ ...scope, kind: 'event' }); assert.equal(store.read(other), undefined);
for (let i = 0; i < 35; i++) store.write(store.open({ ...scope, resourceId: `p-${i}` }), 'bounded', null);
assert.equal(JSON.parse(storage.get('lw.commentDrafts.v1')).length, 30);
now += 24 * 60 * 60 * 1000 + 1;
assert.equal(store.read(store.open({ ...scope, resourceId: 'p-34' })), undefined);
failStorage = true; store = load(); handle = store.open(scope); store.write(handle, 'memory fallback', null);
assert.equal(store.read(handle).text, 'memory fallback');
generation = 'login-b'; store.sessionChanged();
assert.equal(store.read(handle), undefined); assert.equal(store.write(handle, 'old session', null), undefined);
assert.equal(store.read(store.open({ ...scope, generation })), undefined);
generation = 'login-a'; failStorage = false; store = load();
handle = store.open(scope); store.write(handle, 'old handle', null);
for (let i = 0; i < 150; i++) store.open({ ...scope, resourceId: `epoch-${i}` });
assert.equal(store.write(handle, 'evicted callback', null), undefined);
const reopened = store.open(scope); assert.notEqual(reopened.epoch, handle.epoch);
assert.equal(store.write(handle, 'still stale', null), undefined);
const coupleScope = { ...scope, space: 'couple', coupleId: 'couple-a' };
const coupleHandle = store.open(coupleScope); store.write(coupleHandle, 'private couple', null);
store.revokeCouple(generation, scope.userId, 'couple-a');
assert.equal(store.read(coupleHandle), undefined); assert.equal(store.write(coupleHandle, 'revived', null), undefined);
console.log('PASS comment drafts: reload, reply scope, revision fencing, discard/revoke, TTL/cap/length, storage failure, session replacement');
