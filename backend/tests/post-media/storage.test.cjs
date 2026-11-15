'use strict';
// No .env, credentials, DB, or provider calls. In a dependency-free worktree, set
// POST_MEDIA_DEPENDENCY_ROOT to the absolute backend directory with existing node_modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const dependencyRequire = process.env.POST_MEDIA_DEPENDENCY_ROOT
  ? createRequire(path.join(path.resolve(process.env.POST_MEDIA_DEPENDENCY_ROOT), 'package.json'))
  : require;
const ts = dependencyRequire('typescript');
const express = dependencyRequire('express');
const { S3Client, PutObjectCommand } = dependencyRequire('@aws-sdk/client-s3');
const { getSignedUrl } = dependencyRequire('@aws-sdk/s3-request-presigner');
const sourceRoot = path.resolve(__dirname, '../../src');
const MiB = 1024 * 1024;
const fakeEnv = {
  s3: { region: 'us-east-1', bucket: 'offline-test-bucket', accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'synthetic-not-a-real-secret', maxUploadBytes: 5 * MiB },
  trustProxyHops: 0, corsOrigin: 'http://localhost',
};
function load(relative, localRequire = dependencyRequire) {
  const filename = path.join(sourceRoot, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(localRequire, mod, mod.exports);
  return mod.exports;
}
const { MemoryStorageAdapter } = load('integrations/storage/MemoryStorageAdapter.ts');
const { S3StorageAdapter } = load('integrations/storage/S3StorageAdapter.ts', (name) => {
  if (name === '../../config/env.js') return { env: fakeEnv };
  assert.ok(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'].includes(name), `unexpected import ${name}`);
  return dependencyRequire(name);
});
function s3(t) {
  const adapter = new S3StorageAdapter();
  t.after(() => adapter.client.destroy());
  adapter.client.send = async () => { throw new Error('Provider network calls forbidden'); };
  return adapter;
}
async function serve(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return async (method, key, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/dev-storage/${encodeURIComponent(key)}`, method,
      headers: { connection: 'close', ...(body ? { 'content-length': body.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
function memoryApp(adapter, photoCap = 5 * MiB, videoCap = 50 * MiB) {
  const app = express();
  app.use('/api/dev-storage', adapter.router(photoCap, videoCap));
  app.use((err, _req, res, _next) => res.status(err.status || 500).end());
  return app;
}

test('S3 prefix sends Range, copies only the ceiling, stops/destroys if provider ignores it', async (t) => {
  const adapter = s3(t);
  let pulls = 0, destroys = 0, returns = 0;
  const largeChunk = Buffer.alloc(2 * MiB, 0x61);
  const body = {
    transformToByteArray() { assert.fail('must never download the full object'); },
    destroy() { destroys++; },
    [Symbol.asyncIterator]() { return {
      async next() { pulls++; if (pulls > 1) assert.fail('read after byte ceiling'); return { value: largeChunk, done: false }; },
      async return() { returns++; return { done: true }; },
    }; },
  };
  adapter.client.send = async (command) => {
    assert.equal(command.constructor.name, 'GetObjectCommand');
    assert.deepEqual(command.input, { Bucket: fakeEnv.s3.bucket, Key: 'video.mp4', Range: 'bytes=0-65535' });
    return { Body: body, ContentLength: 50 * MiB };
  };
  const prefix = await adapter.getObjectPrefix('video.mp4', 64 * 1024);
  assert.equal(prefix.length, 64 * 1024);
  assert.equal(prefix[0], 0x61);
  assert.notEqual(prefix.buffer, largeChunk.buffer, 'do not retain oversized backing buffer');
  assert.equal(pulls, 1); assert.ok(destroys >= 1); assert.equal(returns, 1);
});

test('S3 prefix streams real Node chunks, handles short objects, errors, and missing bodies', async (t) => {
  const adapter = s3(t);
  for (const [chunks, max, expected] of [
    [[Buffer.from('ab'), Buffer.from('cdef'), Buffer.from('never')], 4, 'abcd'],
    [[Buffer.from('ab')], 10, 'ab'],
    [[], 10, ''],
  ]) {
    const stream = Readable.from(chunks, { objectMode: false, highWaterMark: 1 });
    stream.transformToByteArray = () => assert.fail('full read forbidden');
    adapter.client.send = async () => ({ Body: stream });
    assert.equal((await adapter.getObjectPrefix('video', max)).toString(), expected);
    assert.equal(stream.destroyed, true);
  }
  const stream = Readable.from((async function* () { yield Buffer.from('a'); throw new Error('stream failed'); })());
  adapter.client.send = async () => ({ Body: stream });
  await assert.rejects(adapter.getObjectPrefix('video', 1024), /stream failed/);
  assert.equal(stream.destroyed, true);
  adapter.client.send = async () => ({ Body: { transformToByteArray: () => assert.fail('no full-body fallback') } });
  await assert.rejects(adapter.getObjectPrefix('video', 1024), /destroyable Node stream/);
  adapter.client.send = async () => ({});
  await assert.rejects(adapter.getObjectPrefix('video', 1024), /has no body/);
  adapter.client.send = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(adapter.getObjectPrefix('video', 1024), /storage unavailable/);
});

test('both adapters reject invalid prefix ceilings before attempting storage', async (t) => {
  for (const adapter of [s3(t), new MemoryStorageAdapter('')]) {
    for (const cap of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(adapter.getObjectPrefix('missing', cap), /positive safe integer/);
    }
  }
});

test('S3 offline regression: SDK default signs an empty checksum; adapter signs browser PUT headers only', async (t) => {
  const original = new S3Client({ region: fakeEnv.s3.region, credentials: { accessKeyId: fakeEnv.s3.accessKeyId, secretAccessKey: fakeEnv.s3.secretAccessKey } });
  t.after(() => original.destroy());
  const originalUrl = new URL(await getSignedUrl(original, new PutObjectCommand({
    Bucket: fakeEnv.s3.bucket, Key: 'test.mp4', ContentType: 'video/mp4', ContentLength: 123,
  }), { expiresIn: 120 }));
  assert.equal(originalUrl.searchParams.get('x-amz-checksum-crc32'), 'AAAAAA==', 'installed SDK previously signed CRC32 of empty bytes');
  assert.equal(originalUrl.searchParams.get('x-amz-sdk-checksum-algorithm'), 'CRC32');
  assert.equal(originalUrl.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host', 'default presigner omits MIME header');
  const adapter = s3(t);
  for (const [mimeType, sizeBytes] of [['image/jpeg', 10], ['video/mp4', 50 * MiB], ['video/webm', 20]]) {
    const signed = await adapter.getUploadUrl({ key: 'friends/user/story-videos/test', mimeType, sizeBytes });
    const url = new URL(signed.uploadUrl);
    assert.equal(signed.expiresIn, 120);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
    assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
    assert.ok(![...url.searchParams.keys()].some((key) => /checksum/i.test(key)), 'no empty payload checksum or checksum algorithm requirement');
  }
  const normal = await adapter.getDownloadUrl('private.mp4');
  assert.equal(normal.expiresIn, 300);
  const cached = await adapter.getDownloadUrl('private.mp4', { cacheable: true });
  assert.equal(new URL(cached.url).searchParams.get('X-Amz-Expires'), '7200');
  assert.ok(cached.expiresIn >= 3600 && cached.expiresIn <= 7200);
});

test('existing S3 full getObject and HEAD/delete semantics remain intact', async (t) => {
  const adapter = s3(t);
  adapter.client.send = async () => ({ Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) }, ContentType: 'image/jpeg' });
  assert.deepEqual(await adapter.getObject('photo'), { body: Buffer.from([1, 2, 3]), size: 3, mimeType: 'image/jpeg' });
  adapter.client.send = async () => ({ ContentLength: 3, ContentType: 'video/mp4' });
  assert.deepEqual(await adapter.headObject('video'), { size: 3, mimeType: 'video/mp4' });
  adapter.client.send = async () => { throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }); };
  assert.equal(await adapter.headObject('missing'), null);
  adapter.client.send = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(adapter.headObject('video'), /storage unavailable/);
  adapter.client.send = async (command) => { assert.equal(command.constructor.name, 'DeleteObjectCommand'); assert.equal(command.input.Key, 'video'); };
  await adapter.deleteObject('video');
});

test('memory actual PUT, prefix, metadata, full GET/HEAD, delete and encoded keys', async (t) => {
  const adapter = new MemoryStorageAdapter('http://localhost/');
  const request = await serve(t, memoryApp(adapter));
  const key = 'friends/user/story-videos/100%25 sample.mp4';
  const payload = Buffer.from('0123456789');
  const signed = await adapter.getUploadUrl({ key, mimeType: 'video/mp4', sizeBytes: payload.length });
  assert.equal(signed.expiresIn, 120);
  assert.equal(signed.uploadUrl, `http://localhost/api/dev-storage/${encodeURIComponent(key)}`);
  assert.equal((await request('PUT', key, payload, { 'content-type': 'video/mp4' })).status, 200);
  assert.deepEqual(await adapter.headObject(key), { size: 10, mimeType: 'video/mp4' });
  const prefix = await adapter.getObjectPrefix(key, 4);
  assert.equal(prefix.toString(), '0123');
  prefix[0] = 0;
  assert.equal((await adapter.getObjectPrefix(key, 100)).toString(), payload.toString(), 'prefix must not alias stored object');
  assert.deepEqual(await adapter.getObject(key), { body: payload, mimeType: 'video/mp4', size: 10 });
  for (const method of ['GET', 'HEAD']) {
    const response = await request(method, key);
    assert.equal(response.status, 200);
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['content-length'], '10');
    assert.equal(response.headers['content-type'], 'video/mp4');
    assert.equal(response.headers['content-range'], undefined);
    assert.equal(response.body.toString(), method === 'HEAD' ? '' : '0123456789');
  }
  assert.equal((await adapter.getDownloadUrl(key)).expiresIn, 300);
  await adapter.deleteObject(key);
  assert.equal(await adapter.headObject(key), null);
  await assert.rejects(adapter.getObjectPrefix(key, 1), { name: 'NoSuchKey' });
  await assert.rejects(adapter.getObject(key), { name: 'NoSuchKey' });
  for (const method of ['GET', 'HEAD']) assert.equal((await request(method, key)).status, 404);
});

test('memory GET and HEAD single ranges support inclusive, open, suffix and clamped bounds', async (t) => {
  const adapter = new MemoryStorageAdapter('');
  const request = await serve(t, memoryApp(adapter));
  const key = 'couples/user/story-videos/test.webm';
  await request('PUT', key, Buffer.from('0123456789'), { 'content-type': 'video/webm' });
  const cases = [
    ['bytes=0-0', 0, 0], ['bytes=2-5', 2, 5], ['bytes=7-', 7, 9], ['bytes=-3', 7, 9],
    ['bytes=-20', 0, 9], ['bytes=0-99', 0, 9], ['bytes=0-9', 0, 9],
    ['bytes=-999999999999999999999999999', 0, 9], ['bytes=8-999999999999999999999999999', 8, 9],
  ];
  for (const [range, start, end] of cases) for (const method of ['GET', 'HEAD']) {
    const result = await request(method, key, undefined, { range });
    assert.equal(result.status, 206, `${method} ${range}`);
    assert.equal(result.headers['content-range'], `bytes ${start}-${end}/10`);
    assert.equal(result.headers['content-length'], String(end - start + 1));
    assert.equal(result.headers['accept-ranges'], 'bytes');
    assert.equal(result.headers['content-type'], 'video/webm');
    assert.equal(result.body.toString(), method === 'HEAD' ? '' : '0123456789'.slice(start, end + 1));
  }
});

test('memory invalid/unsatisfiable ranges and empty objects return 416 with size', async (t) => {
  const adapter = new MemoryStorageAdapter('');
  const request = await serve(t, memoryApp(adapter));
  await request('PUT', 'video', Buffer.from('0123456789'));
  for (const range of ['bytes=10-', 'bytes=99-100', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=abc-def', 'bytes=999999999999999999999999999-', 'bytes=1.5-2']) {
    for (const method of ['GET', 'HEAD']) {
      const result = await request(method, 'video', undefined, { range });
      assert.equal(result.status, 416, `${method} ${range}`);
      assert.equal(result.headers['content-range'], 'bytes */10');
      assert.equal(result.headers['content-length'], '0');
      assert.equal(result.headers['accept-ranges'], 'bytes');
      assert.equal(result.body.length, 0);
    }
  }
  await request('PUT', 'empty', Buffer.alloc(0));
  assert.equal((await request('GET', 'empty')).headers['content-length'], '0');
  assert.equal((await adapter.getObjectPrefix('empty', 5)).length, 0);
  for (const method of ['GET', 'HEAD']) {
    const result = await request(method, 'empty', undefined, { range: 'bytes=0-' });
    assert.equal(result.status, 416);
    assert.equal(result.headers['content-range'], 'bytes */0');
  }
});

test('larger memory raw parser is scoped to dedicated friends/couples story-videos branch only', async (t) => {
  const adapter = new MemoryStorageAdapter('');
  const request = await serve(t, memoryApp(adapter, 5, 50));
  for (const key of ['friends/user/story-videos/a.mp4', 'couples/user/story-videos/a.webm']) {
    assert.equal((await request('PUT', key, Buffer.alloc(50))).status, 200);
    assert.equal((await request('PUT', key, Buffer.alloc(51))).status, 413);
    assert.equal((await adapter.headObject(key)).size, 50, 'failed upload cannot overwrite saved bytes');
  }
  for (const key of ['friends/user/stories/a.jpg', 'couples/user/stories/a.jpg', 'avatars/a', 'moments/a', 'friends/user/events/a', 'story-videos/a', 'other/user/story-videos/a', 'friends/user/nested/story-videos/a', 'friends/user/story-videos-evil/a', 'friends/user/story-videos/', 'friends//story-videos/a', 'friends/user%2fstory-videos/a']) {
    assert.equal((await request('PUT', key, Buffer.alloc(5))).status, 200, key);
    assert.equal((await request('PUT', key, Buffer.alloc(6))).status, 413, key);
    assert.equal((await adapter.headObject(key)).size, 5);
  }
});

test('actual app mount preserves 5 MiB photos, permits 50 MiB post videos, and keeps JSON cap', async (t) => {
  const adapter = new MemoryStorageAdapter('');
  const next = (_req, _res, next) => next();
  const noop = () => {};
  const { createApp } = load('app.ts', (name) => {
    if (['express', 'cors', 'helmet', 'zod'].includes(name)) return dependencyRequire(name);
    if (name === './config/env.js') return { env: fakeEnv, isProd: false };
    if (name === './integrations/index.js') return { getMemoryStorage: () => adapter, getMockPush: () => null };
    if (name === './middleware/errorHandler.js') return { errorHandler: (err, _req, res, _next) => res.status(err.status || 500).end(), notFoundHandler: (_req, res) => res.status(404).end() };
    if (name === './middleware/requestMetrics.js') return { requestMetrics: next, metricArea: () => next };
    if (name.startsWith('./routes/')) return new Proxy({}, { get: () => express.Router() });
    if (name.startsWith('./services/')) return new Proxy({}, { get: () => noop });
    if (name.startsWith('./middleware/')) return new Proxy({}, { get: () => next });
    throw new Error(`Unexpected app import: ${name}`);
  });
  const request = await serve(t, createApp());
  const photoKey = 'friends/user/stories/cap.jpg';
  assert.equal((await request('PUT', photoKey, Buffer.alloc(5 * MiB), { 'content-type': 'image/jpeg' })).status, 200);
  assert.equal((await request('PUT', photoKey, Buffer.alloc(5 * MiB + 1), { 'content-type': 'image/jpeg' })).status, 413);
  const videoKey = 'friends/user/story-videos/cap.mp4';
  assert.equal((await request('PUT', videoKey, Buffer.alloc(50 * MiB), { 'content-type': 'video/mp4' })).status, 200);
  assert.equal((await adapter.headObject(videoKey)).size, 50 * MiB);
  assert.equal((await request('PUT', videoKey, Buffer.alloc(50 * MiB + 1), { 'content-type': 'video/mp4' })).status, 413);
  await adapter.deleteObject(videoKey);
  // POST misses the dev PUT router and reaches the real app's unchanged global JSON parser.
  const json = Buffer.from(JSON.stringify({ body: 'x'.repeat(256 * 1024) }));
  assert.equal((await request('POST', 'json-check', json, { 'content-type': 'application/json' })).status, 413);
});
