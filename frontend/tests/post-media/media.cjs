'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'frontend')]) {
      try { return require(require.resolve('typescript', { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
function load(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../../src/features/stories', relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, Error, DOMException, AbortController,
    Uint8Array, DataView, Blob, File, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const png = (name = 'photo.png', type = 'image/png') => new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), 'pixels'], name, { type });
const mp4 = (type = 'video/mp4', brand = 'isom') => new File([Uint8Array.from([0, 0, 0, 24]), 'ftyp', brand, new Uint8Array(4), 'mp41', new Uint8Array(4)], 'clip.mp4', { type });
const webm = (type = 'video/webm') => new File([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84]), 'webm'], 'clip.webm', { type });
const sized = (file, size) => { Object.defineProperty(file, 'size', { value: size }); return file; };

function environment(options = {}) {
  const urls = new Map(); const revoked = []; const bitmaps = []; const canvases = []; const videos = []; const images = []; const timers = new Map();
  let sequence = 0;
  const globals = {
    URL: {
      createObjectURL(blob) { const url = `blob:test-${++sequence}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { assert.ok(urls.delete(url), `URL revoked once: ${url}`); revoked.push(url); },
    },
    createImageBitmap: async blob => {
      if (options.bitmap) return options.bitmap(blob);
      if (options.bitmapFail) throw new Error('unsupported');
      const bitmap = { width: 4000, height: 3000, closed: 0, close() { this.closed++; } }; bitmaps.push(bitmap); return bitmap;
    },
    Image: class {
      constructor() { this.naturalWidth = 2000; this.naturalHeight = 1000; images.push(this); }
      set src(value) { this.source = value; if (!options.imagePending) queueMicrotask(() => options.imageFail ? this.onerror?.() : this.onload?.()); }
      removeAttribute() { this.source = ''; }
      decode() { return options.imageDecodeFail ? Promise.reject(new Error('pixels')) : Promise.resolve(); }
    },
    document: {
      createElement(tag) {
        if (tag === 'canvas') {
          const canvas = { width: 0, height: 0, qualities: [], getContext() { return options.noContext ? null : { drawImage() { if (options.drawFail) throw new Error('draw'); } }; },
            toBlob(callback, type, quality) { this.qualities.push(quality); if (options.encodePending) { this.callback = callback; return; }
              callback(options.nullOutput ? null : new Blob([new Uint8Array(options.outputSize ?? 10)], { type: options.outputType ?? type })); },
          }; canvases.push(canvas); return canvas;
        }
        assert.equal(tag, 'video');
        const video = { videoWidth: options.videoWidth ?? 1920, videoHeight: options.videoHeight ?? 1080, readyState: 2, paused: 0, loaded: 0,
          pause() { this.paused++; }, removeAttribute() { this.src = ''; },
          load() { this.loaded++; if (this.src && !options.videoPending) queueMicrotask(() => options.videoFail ? this.onerror?.() : this.onloadeddata?.()); },
          play() { assert.fail('decode must never autoplay'); },
        }; videos.push(video); return video;
      },
    },
  };
  if (options.manualTimers) {
    globals.setTimeout = fn => { const id = ++sequence; timers.set(id, fn); return id; };
    globals.clearTimeout = id => timers.delete(id);
  }
  const api = load('postMedia.ts', {}, globals);
  return { api, urls, revoked, bitmaps, canvases, videos, images, timers,
    prepare: (file, signal = new AbortController().signal) => api.preparePostMedia(file, signal) };
}

// Hook renderer with queued functional updates, dependency cleanup, and StrictMode effect replay.
function hookHarness(helper, existing = [], initialFiles = []) {
  const states = []; const refs = []; const effects = []; const updates = []; let stateCursor; let refCursor; let effectCursor; let mounted = true; let value;
  const react = {
    useState(init) { const i = stateCursor++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], update => updates.push([i, update])]; },
    useRef(init) { const i = refCursor++; return refs[i] ??= { current: init }; },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) { const i = effectCursor++; const old = effects[i];
      if (!old || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) effects[i] = { fn, deps, cleanup: old?.cleanup, pending: true }; },
  };
  const hook = load('usePostMedia.ts', { react, './postMedia': helper }).usePostMedia;
  function render() {
    while (updates.length) { const [i, update] = updates.shift(); states[i] = typeof update === 'function' ? update(states[i]) : update; }
    stateCursor = refCursor = effectCursor = 0;
    value = hook(existing, initialFiles);
    return value;
  }
  function flush() {
    assert.ok(mounted);
    render();
    for (const effect of effects) if (effect.pending) { effect.cleanup?.(); effect.pending = false; effect.cleanup = effect.fn(); }
    return value;
  }
  return { render, flush, get value() { return value; },
    replay() { for (const effect of effects) { effect.cleanup?.(); effect.cleanup = effect.fn(); } },
    unmount() { mounted = false; for (const effect of effects) effect.cleanup?.(); },
    get updateCount() { return updates.length; },
  };
}

(async () => {
  let env = environment();
  assert.equal(env.api.MAX_POST_MEDIA, 10); assert.equal(env.api.MAX_POST_VIDEOS, 1); assert.equal(env.api.MAX_VIDEO_BYTES, 50 * 1024 * 1024);
  assert.match(env.api.POST_MEDIA_ACCEPT, /\.heic.*\.heif.*\.mp4.*\.webm/);
  for (const mime of ['image/png', '', 'application/octet-stream']) {
    const result = await env.prepare(png('no-extension', mime));
    assert.equal(result.mediaType, 'image'); assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.blob.type, 'image/jpeg'); assert.equal(result.width, 1600); assert.equal(result.height, 1200);
  }
  assert.ok(env.bitmaps.every(bitmap => bitmap.closed === 1));
  assert.ok(env.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)); assert.equal(env.urls.size, 0);
  await assert.rejects(env.prepare(new File([], 'empty.png', { type: 'image/png' })), /trống/);
  await assert.rejects(env.prepare(new File(['pdf'], 'file.pdf', { type: 'application/pdf' })), /chưa được hỗ trợ/);
  await assert.rejects(env.prepare(sized(png(), 30 * 1024 * 1024 + 1)), /30 MiB/);
  await assert.rejects(env.prepare(sized(mp4(), 50 * 1024 * 1024 + 1)), /50 MiB/);
  await assert.rejects(env.prepare(mp4('video/webm')), /không khớp/);
  await assert.rejects(env.prepare(mp4('video/mp4', 'nope')), /không khớp/);
  await assert.rejects(env.prepare(mp4('video/mp4', 'heic')), /không khớp/);
  await assert.rejects(env.prepare(mp4('video/mp4', 'avif')), /không khớp/);
  await assert.rejects(env.prepare(mp4('video/mp4', 'qt  ')), /không khớp/);
  await assert.rejects(env.prepare(mp4('video/quicktime', 'isom')), /không khớp/);
  await assert.rejects(env.prepare(new File(['not a container'], 'clip.mp4', { type: 'video/mp4' })), /không khớp/);
  await assert.rejects(env.prepare(new File([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 'matroska'], 'clip.webm', { type: 'video/webm' })), /không khớp/);
  await assert.rejects(env.prepare(mp4('image/png')), /chứa video/);
  const heic = new File([Uint8Array.from([0, 0, 0, 24]), 'ftypheic', new Uint8Array(4), 'mif1', new Uint8Array(4)], 'photo.heic', { type: 'application/octet-stream' });
  env = environment({ bitmapFail: true });
  const fallback = await env.prepare(heic);
  assert.equal(fallback.width, 1600); assert.equal(fallback.height, 800); assert.equal(env.urls.size, 0); assert.equal(env.revoked.length, 1);
  assert.equal(env.images[0].source, '');
  // Extension is only an admission hint: actual image decoding must still succeed.
  env = environment({ bitmapFail: true, imageFail: true });
  await assert.rejects(env.prepare(new File(['broken'], 'photo.PNG')), /JPEG\/PNG/);
  await assert.rejects(env.prepare(heic), /HEIC/); assert.equal(env.urls.size, 0);
  env = environment({ bitmapFail: true, imageDecodeFail: true });
  await assert.rejects(env.prepare(png()), /Không đọc được ảnh/); assert.equal(env.urls.size, 0);
  for (const options of [{ noContext: true }, { drawFail: true }, { nullOutput: true }, { outputType: 'image/png' }, { outputSize: 5 * 1024 * 1024 + 1 }]) {
    env = environment(options); await assert.rejects(env.prepare(png()));
    assert.equal(env.bitmaps[0].closed, 1); assert.equal(env.canvases[0].width, 0); assert.equal(env.canvases[0].height, 0);
  }
  env = environment({ bitmapFail: true, imagePending: true });
  let controller = new AbortController(); let pending = env.prepare(png(), controller.signal); await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(env.urls.size, 0);
  const lateBitmap = deferred(); env = environment({ bitmap: () => lateBitmap.promise }); controller = new AbortController();
  pending = env.prepare(png(), controller.signal); await tick(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  let closed = 0; lateBitmap.resolve({ width: 4, height: 4, close() { closed++; } }); await tick(); assert.equal(closed, 1);
  env = environment({ encodePending: true }); controller = new AbortController(); pending = env.prepare(png(), controller.signal); await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(env.canvases[0].width, 0); assert.equal(env.bitmaps[0].closed, 1);

  env = environment();
  for (const file of [mp4(), mp4(''), webm(), webm('application/octet-stream')]) {
    const result = await env.prepare(file);
    assert.equal(result.mediaType, 'video'); assert.equal(result.width, 1920); assert.equal(result.height, 1080);
    assert.equal(result.mimeType, result.blob.type); assert.equal(result.blob.size, file.size);
  }
  // Fixtures exercise classification, not actual codec playback (the video element is mocked).
  for (const mime of ['video/quicktime', '', 'application/octet-stream', 'VIDEO/QUICKTIME; codecs=hvc1']) {
    const file = mp4(mime, 'qt  '); const result = await env.prepare(file);
    assert.equal(result.mimeType, 'video/quicktime'); assert.equal(result.blob.type, 'video/quicktime');
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), Buffer.from(await file.arrayBuffer()));
  }
  const box = (type, payload, extended = false) => {
    const result = Buffer.alloc((extended ? 16 : 8) + payload.length);
    result.writeUInt32BE(extended ? 1 : result.length, 0); result.write(type, 4, 'latin1');
    if (extended) result.writeBigUInt64BE(BigInt(result.length), 8);
    Buffer.from(payload).copy(result, extended ? 16 : 8); return result;
  };
  const ftyp = (major, brands = [], extended = false) => box('ftyp', Buffer.concat([Buffer.from(major, 'latin1'), Buffer.alloc(4), ...brands.map(b => Buffer.from(b, 'latin1'))]), extended);
  const movFile = bytes => new File([bytes], 'clip.mov', { type: 'video/quicktime' });
  await assert.rejects(env.prepare(new File(['not a video'], 'clip.mov')), /chưa được hỗ trợ/);
  await assert.rejects(env.prepare(sized(movFile(ftyp('qt  ')), 50 * 1024 * 1024 + 1)), /50 MiB/);
  for (const bytes of [ftyp('qt  '), ftyp('qt  ', ['isom'], true), Buffer.concat([box('free', Buffer.alloc(0)), box('skip', Buffer.alloc(0)), box('wide', Buffer.alloc(0)), ftyp('qt  ')])]) {
    assert.equal((await env.prepare(movFile(bytes))).mimeType, 'video/quicktime');
  }
  for (const bytes of [ftyp('heic', ['qt  ']), ftyp('avif', ['qt  ']), ftyp('qt  ', ['heic']), ftyp('qt  ', ['avif']), ftyp('isom', ['qt  ']),
    ftyp('qt  ').subarray(0, 15), Buffer.from('00000000667479707174202000000000', 'hex'), Buffer.from('0000001166747970717420200000000000', 'hex'),
    Buffer.from('0000000166747970', 'hex'), Buffer.from('0000000166747970ffffffffffffffff', 'hex'),
    Buffer.from('000000016674797000000000000000187174202000000000', 'hex').subarray(0, 23)]) {
    await assert.rejects(env.prepare(movFile(bytes)), /không khớp/);
  }
  assert.equal(env.urls.size, 0);
  assert.ok(env.videos.every(video => video.paused === 1 && video.preload === 'auto' && video.autoplay === false && !video.src));
  for (const options of [{ videoFail: true }, { videoWidth: 0 }]) {
    env = environment(options); await assert.rejects(env.prepare(mp4()), /MP4 H.264/); assert.equal(env.urls.size, 0);
  }
  for (const file of [mp4(), webm(), mp4('video/quicktime', 'qt  ')]) {
    env = environment({ videoPending: true }); controller = new AbortController(); pending = env.prepare(file, controller.signal); await tick();
    assert.equal(env.videos.length, 1); assert.equal(env.videos[0].onloadedmetadata, undefined, 'metadata alone does not complete preparation');
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(env.urls.size, 0);
    env = environment({ videoPending: true, manualTimers: true }); pending = env.prepare(file); await tick();
    for (const timer of [...env.timers.values()]) timer();
    await assert.rejects(pending, /30 giây/); assert.equal(env.urls.size, 0); assert.equal(env.timers.size, 0);
  }

  // Integration: actual helper + actual hook; render/init creates no object URLs, effects own all decoding.
  env = environment({ bitmapFail: true });
  let hook = hookHarness(env.api, [], [png()]);
  hook.render(); assert.equal(env.urls.size, 0); assert.equal(env.images.length, 0); assert.equal(hook.value.pending, true);
  hook.flush(); hook.replay(); await tick(); hook.flush();
  assert.equal(hook.value.media[0].status, 'ready'); assert.equal(hook.value.pending, false); assert.equal(env.urls.size, 0); hook.unmount();
  env = environment({ bitmapFail: true, imagePending: true });
  hook = hookHarness(env.api, [], [png()]); hook.flush(); await tick();
  assert.equal(env.urls.size, 1); hook.replay(); assert.equal(env.urls.size, 0, 'StrictMode cleanup revokes the first decode URL');
  await tick(); assert.equal(env.urls.size, 1); assert.equal(env.images.length, 2);
  env.images[1].onload(); await tick(); hook.flush(); assert.equal(hook.value.media[0].status, 'ready');
  assert.equal(env.urls.size, 0); hook.unmount();

  const jobs = [];
  const helper = { MAX_POST_MEDIA: 10, MAX_POST_VIDEOS: 1,
    preparePostMedia(file, signal) { const task = { file, signal, ...deferred() }; jobs.push(task); return task.promise; },
  };
  const prepared = (type = 'image') => ({ mediaType: type, mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4', width: 1, height: 1, blob: new Blob(['ready']) });
  hook = hookHarness(helper, [], [png('first.png')]); hook.flush(); hook.replay();
  assert.equal(jobs.length, 2); assert.equal(jobs[0].signal.aborted, true);
  jobs[0].resolve(prepared()); await tick(); hook.flush(); assert.equal(hook.value.media[0].status, 'processing', 'stale StrictMode result ignored');
  hook.value.addFiles([png('second.png')]); hook.value.addFiles([png('third.png')]); hook.flush(); assert.equal(jobs.length, 2, 'rapid append does not restart current task');
  jobs[1].resolve(prepared()); await tick(); hook.flush(); assert.equal(jobs.length, 3, 'next task starts only after first settles');
  const removed = hook.value.media[1].id; hook.value.remove(removed); assert.equal(jobs[2].signal.aborted, true); hook.flush(); assert.equal(jobs.length, 4);
  jobs[2].resolve(prepared()); await tick(); hook.flush(); assert.equal(hook.value.media.some(item => item.id === removed), false);
  hook.unmount(); assert.equal(jobs[3].signal.aborted, true); jobs[3].resolve(prepared()); await tick(); assert.equal(hook.updateCount, 0, 'unmounted task cannot set state');

  jobs.length = 0;
  const existing = Array.from({ length: 8 }, (_, i) => ({ id: `saved-${i}`, kind: 'existing', mediaType: 'image', key: `key-${i}`, url: `https://example.test/${i}`, width: 4, height: 4 }));
  hook = hookHarness(helper, existing, [png('bad.png'), mp4(), mp4(), png('last.png'), png('extra.png')]); hook.flush();
  jobs[0].reject(new Error('Ảnh hỏng, hãy chọn lại.')); await tick(); hook.flush();
  jobs[1].resolve(prepared('video')); await tick(); hook.flush();
  jobs[2].resolve(prepared('video')); await tick(); hook.flush();
  assert.match(hook.value.media[10].error, /1 video/);
  jobs[3].resolve(prepared()); await tick(); hook.flush();
  jobs[4].resolve(prepared()); await tick(); hook.flush();
  assert.equal(hook.value.media.filter(item => item.kind === 'existing' || item.status === 'ready').length, 10);
  assert.equal(hook.value.media.filter(item => item.kind === 'new' && item.status === 'error').length, 3);
  assert.match(hook.value.media[12].error, /10 ảnh và video/); assert.equal(hook.value.pending, false); assert.equal(hook.value.errors, true);
  // Removing an error frees no valid slot; removing a valid item permits selecting the very same file again.
  const retryFile = hook.value.media[12].file;
  hook.value.remove('saved-0'); hook.value.remove(hook.value.media[12].id); hook.value.addFiles([retryFile]); hook.flush();
  jobs[5].resolve(prepared()); await tick(); hook.flush(); assert.equal(hook.value.media.at(-1).status, 'ready');
  for (const item of hook.value.media) if (item.kind === 'new' && item.status === 'error') hook.value.remove(item.id);
  hook.flush(); assert.equal(hook.value.errors, false);
  assert.equal(new Set(hook.value.media.map(item => item.id)).size, hook.value.media.length); hook.unmount();
  console.log('PASS post media: sniffing/limits, image fallback + JPEG resize, video first-frame validation, URL/bitmap/canvas cleanup, sequential hook queue, caps, errors, StrictMode/remove/unmount cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
