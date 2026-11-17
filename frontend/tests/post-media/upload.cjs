'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../..')] }));
const requests = [];
const outcomes = [];
class XMLHttpRequest {
  upload = {};
  headers = {};
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(blob) {
    requests.push({ method: this.method, url: this.url, headers: this.headers, blob, timeout: this.timeout });
    this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size });
    const outcome = outcomes.shift() ?? 200;
    queueMicrotask(() => {
      if (typeof outcome === 'string') this[outcome]();
      else { this.status = outcome; this.onload(); }
    });
  }
}
const filename = path.resolve(__dirname, '../../src/features/stories/uploadPostMedia.ts');
const moduleStub = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: moduleStub.exports, module: moduleStub, XMLHttpRequest, Error });
const { uploadPostMedia, putPostMedia } = moduleStub.exports;
const photo = { id: 'p', kind: 'new', mediaType: 'image', status: 'ready', width: 320, height: 180,
  mimeType: 'image/jpeg', blob: new Blob(['image'], { type: 'image/jpeg' }) };
const video = { ...photo, id: 'v', mediaType: 'video', mimeType: 'video/webm', blob: new Blob(['video'], { type: 'video/webm' }) };
const signed = [];
let serial = 0;
const urls = {
  uploadUrl: async (type, size) => { signed.push([type, size]); return { uploadUrl: `https://storage.invalid/p${++serial}`, imageKey: `photo-${serial}`, maxBytes: 5e6 }; },
  videoUploadUrl: async (type, size) => { signed.push([type, size]); return { uploadUrl: `https://storage.invalid/v${++serial}`, videoKey: `video-${serial}`, maxBytes: 50e6 }; },
};
(async () => {
  const cache = new Map(); const statuses = [];
  outcomes.push(200, 503);
  await assert.rejects(uploadPostMedia([photo, video], cache, urls, value => statuses.push(value)), /thất bại/);
  assert.equal(cache.size, 1, 'successful photo retained after failed video');
  assert.equal(requests.length, 2);
  const failedUrl = requests[1].url;
  const out = await uploadPostMedia([photo, video], cache, urls, () => {});
  assert.equal(requests.length, 3, 'retry uploads failed video only');
  assert.notEqual(requests[2].url, failedUrl, 'fresh signed URL on retry');
  assert.equal(out.photos.length, 1); assert.equal(out.videos.length, 1);
  assert.equal(out.videos[0].mimeType, 'video/webm');
  assert.ok(statuses.some(value => value.includes('100%')));
  for (const request of requests) {
    assert.equal(request.method, 'PUT');
    assert.deepEqual(Object.keys(request.headers), ['Content-Type']);
    assert.equal(request.headers['Content-Type'], request.blob.type);
    assert.equal(request.timeout, 600000);
  }
  await uploadPostMedia([photo, video], cache, urls, () => {});
  assert.equal(requests.length, 3, 'post-save retry reuses both uploads');
  const existing = [{ kind: 'existing', id: 'e', mediaType: 'video', key: 'retained', mimeType: 'video/mp4', width: 12, height: 8 }];
  const retained = await uploadPostMedia(existing, new Map(), urls, () => {});
  assert.equal(retained.videos[0].key, 'retained');
  assert.equal(requests.length, 3);
  await assert.rejects(uploadPostMedia([{ ...photo, status: 'processing' }], new Map(), urls, () => {}), /chưa xử lý/);
  await assert.rejects(uploadPostMedia([photo], new Map(), { ...urls, uploadUrl: async () => ({ uploadUrl: 'https://storage.invalid/cap', imageKey: 'x', maxBytes: 1 }) }, () => {}), /kích thước/);
  assert.equal(requests.length, 3, 'oversized bytes not PUT');
  for (const [outcome, message] of [['onerror', /Không kết nối/], ['ontimeout', /quá lâu/], ['onabort', /hủy/], [403, /thất bại/]]) {
    outcomes.push(outcome); await assert.rejects(putPostMedia('https://storage.invalid/test', photo.blob), message);
  }
  const mov = { ...video, id: 'mov', mimeType: 'video/quicktime', blob: new Blob(['original MOV bytes'], { type: 'video/quicktime' }) };
  const movResult = await uploadPostMedia([mov], new Map(), urls, () => {});
  assert.equal(movResult.videos[0].mimeType, 'video/quicktime');
  assert.deepEqual(signed.at(-1), ['video/quicktime', mov.blob.size]);
  assert.equal(requests.at(-1).headers['Content-Type'], 'video/quicktime');
  assert.equal(requests.at(-1).blob, mov.blob, 'original prepared bytes sent unchanged');
  let active = true; let signCount = 0;
  const guardedUrls = { ...urls, uploadUrl: async (...args) => { signCount++; return urls.uploadUrl(...args); },
    videoUploadUrl: async (...args) => { signCount++; return urls.videoUploadUrl(...args); } };
  const assertActive = () => { if (!active) throw new Error('SESSION_CHANGED'); };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (blob) { originalSend.call(this, blob); active = false; };
  const guardedCache = new Map();
  await assert.rejects(uploadPostMedia([video, photo], guardedCache, guardedUrls, () => {}, assertActive), /SESSION_CHANGED/);
  assert.equal(signCount, 1, 'session change during PUT prevents second signing and save continuation');
  assert.equal(guardedCache.size, 0, 'stale upload result is not applied');
  XMLHttpRequest.prototype.send = originalSend;
  active = true;
  const before = requests.length;
  await assert.rejects(uploadPostMedia([photo], new Map(), { ...urls, uploadUrl: async (...args) => { active = false; return urls.uploadUrl(...args); } }, () => {}, assertActive), /SESSION_CHANGED/);
  assert.equal(requests.length, before, 'unmounted/session-changed signing result is never PUT');
  console.log('PASS post-media uploader: sequential PUT, progress, retry cache, fresh signatures, existing descriptors, caps, errors, no API Authorization');
})().catch(error => { console.error(error); process.exitCode = 1; });
