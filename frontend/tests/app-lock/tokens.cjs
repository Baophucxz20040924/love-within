const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../../src/lib/tokenStore.ts'), 'utf8');
const values = new Map([['lw.sessionGeneration', 'legacy-id'], ['lw.accessToken', 'old-access'], ['lw.refreshToken', 'old-refresh']]);
let observe = () => {};
const localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); observe(); },
  removeItem: key => { values.delete(key); observe(); },
};
let seq = 0;
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: exportsObject, localStorage, crypto: { randomUUID: () => `session-${++seq}` } });
const store = exportsObject.tokenStore;
assert.equal(store.generation(), 'legacy-id');
assert.equal(store.get().accessToken, 'old-access');
const snapshots = [];
observe = () => snapshots.push({ generation: store.generation(), tokens: store.get() });
store.set({ accessToken: 'new-access', refreshToken: 'new-refresh' });
assert.equal(snapshots.length, 3);
for (const snapshot of snapshots) {
  assert.equal(snapshot.generation, 'session-1');
  assert.equal(snapshot.tokens.accessToken, 'new-access');
  assert.equal(snapshot.tokens.refreshToken, 'new-refresh');
}
snapshots.length = 0;
assert.equal(store.rotate({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }, 'session-1'), true);
for (const snapshot of snapshots) {
  assert.equal(snapshot.generation, 'session-1');
  assert.equal(snapshot.tokens.accessToken, 'rotated-access');
  assert.equal(snapshot.tokens.refreshToken, 'rotated-refresh');
}
assert.equal(store.rotate({ accessToken: 'stale', refreshToken: 'stale' }, 'legacy-id'), false);
assert.equal(store.clear('legacy-id'), false);
snapshots.length = 0;
assert.equal(store.clear('session-1'), true);
for (const snapshot of snapshots) {
  assert.equal(snapshot.generation, 'session-2');
  assert.equal(snapshot.tokens, null);
}
values.set('lw.accessToken', 'leftover');
values.set('lw.refreshToken', 'leftover');
assert.equal(store.get(), null);
values.set('lw.sessionGeneration', '{broken');
assert.equal(store.get(), null);
console.log('PASS atomic token publication, rotation, logout, stale writes and legacy migration');
