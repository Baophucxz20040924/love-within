'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function typescript() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    try { return require(require.resolve('typescript', { paths: [dir, path.join(dir, 'frontend')] })); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    if (path.dirname(dir) === dir) throw new Error('Installed TypeScript not found');
  }
}
const ts = typescript();
function load(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, Error, DOMException, AbortController,
    Uint8Array, DataView, Blob, File, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unmocked import ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
function setup(options = {}) {
  const calls = [], closed = [], canvases = [], urls = [];
  const postMedia = load('features/stories/postMedia.ts', {}, {
    createImageBitmap: async () => {
      if (options.decodeFail) throw Error('bad image');
      return { width: 1600, height: 900, close() { closed.push(true); } };
    },
    URL: { createObjectURL() { urls.push('blob:decode'); return 'blob:decode'; }, revokeObjectURL() { urls.pop(); } },
    Image: class { set src(_) { queueMicrotask(() => this.onerror()); } removeAttribute() {} },
    document: { createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 0, height: 0, getContext: () => options.noCanvas ? null : { drawImage() {} },
        toBlob(callback, type) { callback(options.encodeFail ? null : new Blob(['encoded-jpeg'], { type })); } };
      canvases.push(canvas); return canvas;
    } },
  });
  let failSign = options.signFail, failUpload = options.uploadFail;
  const api = load('features/water/api.ts', {
    '../../lib/apiClient': { apiRequest: async (url, input) => {
      calls.push(['request', url, input]);
      if (url === '/water/upload-url') {
        if (failSign) throw Error('sign failed');
        return { uploadUrl: 'signed-put', imageKey: 'member-proof-key', maxBytes: options.maxBytes ?? 5 * 1024 * 1024 };
      }
      return { status: 'pending' };
    } },
    '../../lib/image': { compressImage: async () => assert.fail('Never use fallback compressor for manual proofs') },
    '../stories/postMedia': postMedia,
    '../stories/uploadPostMedia': { putPostMedia: async (url, blob, progress) => {
      calls.push(['put', url, blob]); if (failUpload) throw Error('upload failed'); progress(50); progress(100);
    } },
  });
  return { ...api, calls, closed, canvases, urls, retry() { failSign = false; failUpload = false; } };
}
const png = () => new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), 'pixels'], 'photo.png', { type: 'image/png' });

test('manual proof decodes/reencodes to new JPEG, releases pixels and sends explicit signing purpose/key', async () => {
  const x = setup(), input = png(), progress = [];
  const blob = await x.prepareWaterProof(input, new AbortController().signal);
  assert.notEqual(blob, input); assert.equal(blob.type, 'image/jpeg'); assert.equal(x.closed.length, 1);
  assert.equal(x.canvases[0].width, 0); assert.equal(x.canvases[0].height, 0);
  const key = await x.uploadWaterProof(blob, n => progress.push(n), () => {});
  await x.waterApi.manual(250, key);
  assert.deepEqual(progress, [50, 100]);
  const sign = x.calls.find(c => c[1] === '/water/upload-url')[2].body;
  assert.equal(sign.purpose, 'manual_proof'); assert.equal(sign.mimeType, 'image/jpeg'); assert.equal(sign.sizeBytes, blob.size);
  const post = x.calls.find(c => c[1] === '/water/manual')[2].body;
  assert.equal(post.amountMl, 250); assert.equal(post.imageKey, 'member-proof-key');
  assert.equal(x.calls.some(c => c[1] === '/water/photo'), false);
});

test('no-photo manual path omits proof and performs no upload or AI request', async () => {
  const x = setup(); await x.waterApi.manual(350);
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0][1], '/water/manual');
  assert.equal(Object.hasOwn(x.calls[0][2].body, 'imageKey'), false);
});

test('decode/encode/canvas failures never fall back to original bytes or sign an upload', async () => {
  for (const opts of [{ decodeFail: true }, { noCanvas: true }, { encodeFail: true }]) {
    const x = setup(opts);
    await assert.rejects(x.prepareWaterProof(png(), new AbortController().signal));
    assert.equal(x.calls.length, 0); assert.equal(x.urls.length, 0);
    if (!opts.decodeFail) assert.equal(x.closed.length, 1);
  }
});

test('video or disguised video, aborted input and bad output are rejected before upload', async () => {
  const x = setup();
  const video = new File([Uint8Array.from([0, 0, 0, 24]), 'ftypisom', new Uint8Array(12)], 'clip.mp4', { type: 'video/mp4' });
  await assert.rejects(x.prepareWaterProof(video, new AbortController().signal), /không chọn video/);
  const disguised = new File([video], 'fake.jpg', { type: 'image/jpeg' });
  await assert.rejects(x.prepareWaterProof(disguised, new AbortController().signal));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(x.prepareWaterProof(png(), abort.signal));
  for (const blob of [new Blob([], { type: 'image/jpeg' }), new Blob(['x'], { type: 'image/png' }), new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' })]) {
    await assert.rejects(x.uploadWaterProof(blob, () => {}, () => {}));
  }
  assert.equal(x.calls.length, 0);
});

test('sign/upload failure can retry, obsolete scope cannot upload and server cap is respected', async () => {
  const blob = new Blob(['encoded'], { type: 'image/jpeg' });
  for (const options of [{ signFail: true }, { uploadFail: true }]) {
    const x = setup(options);
    await assert.rejects(x.uploadWaterProof(blob, () => {}, () => {}));
    x.retry(); assert.equal(await x.uploadWaterProof(blob, () => {}, () => {}), 'member-proof-key');
  }
  const small = setup({ maxBytes: 1 }); await assert.rejects(small.uploadWaterProof(blob, () => {}, () => {}));
  assert.equal(small.calls.some(c => c[0] === 'put'), false);
  const obsolete = setup(); let checks = 0;
  await assert.rejects(obsolete.uploadWaterProof(blob, () => {}, () => { if (++checks > 1) throw Error('scope changed'); }));
  assert.equal(obsolete.calls.some(c => c[0] === 'put'), false);
});

// A small hook harness exercises sheet controls and asynchronous mutation paths without a browser/provider.
function sheetHarness(options = {}) {
  const states = [], refs = [], effects = [], mutations = [], calls = [], revoked = [];
  let cursor, refCursor, effectCursor, mutationCursor, tree, open = true;
  const react = {
    useState(init) { const i = cursor++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(init) { const i = refCursor++; return refs[i] ??= { current: init }; },
    useEffect(fn, deps) { const i = effectCursor++, old = effects[i]; if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) effects[i] = { fn, deps, cleanup: old?.cleanup, pending: true }; },
  };
  class ApiRequestError extends Error {}
  let seq = 0;
  const component = load('features/water/WaterSheets.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries: async () => { calls.push(['invalidate']); } }),
      useMutation: config => {
        const i = mutationCursor++;
        const m = mutations[i] ??= { isError: false, isPending: false, reset() { m.isError = false; m.error = null; },
          mutate() { m.isPending = true; m.promise = m.config.mutationFn().then(async r => { m.isPending = false; await m.config.onSuccess?.(r); }, err => { m.isPending = false; m.isError = true; m.error = err; }).finally(() => m.config.onSettled?.()); } };
        m.config = config;
        return m;
      },
    },
    '../../components/BottomSheet': { BottomSheet: 'BottomSheet' }, '../../components/Icon': { Icon: 'Icon' },
    '../../components/Toast': { useToast: () => ({ success: text => calls.push(['toast', text]) }) },
    '../auth/AuthContext': { useAuth: () => ({ me: null }) }, '../proposals/api': { PROPOSAL_KEY: ['proposal'] },
    '../../lib/apiClient': { ApiRequestError, assertCurrentSession() {}, currentAccessEpoch: () => 1 },
    '../../lib/tokenStore': { tokenStore: { generation: () => 'session' } },
    '../../lib/format': { formatMl: n => `${n} ml`, formatNumber: String, shortName: String },
    '../push/suggest': { pushSuggest: { trigger() {} } },
    './api': { WATER_KEY: ['water'], WATER_PENDING_KEY: ['pending'],
      prepareWaterProof: async () => { if (options.decodeFail) throw Error('decode failed'); return new Blob(['jpeg'], { type: 'image/jpeg' }); },
      uploadWaterProof: async (_blob, progress, active) => { active(); calls.push(['upload']); if (options.uploadFail) throw Error('upload failed'); progress(100); return 'proof'; },
      waterApi: { manual: async (...args) => { calls.push(['manual', ...args]); if (options.postFail) throw Error('unclear result'); return { amountMl: 250 }; } },
    },
  }, { URL: { createObjectURL: () => `blob:${++seq}`, revokeObjectURL: url => revoked.push(url) } }).ManualWaterSheet;
  function render() {
    cursor = refCursor = effectCursor = mutationCursor = 0;
    tree = component({ open, onClose: () => { calls.push(['close']); } });
    return tree;
  }
  function flush() {
    render(); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return render();
  }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; return [node, ...[node.props?.children].flat(Infinity).filter(n => n !== undefined).flatMap(n => nodes(n))]; }
  const tick = async () => { await new Promise(r => setImmediate(r)); flush(); };
  flush();
  return { calls, revoked, options, flush, tick, nodes, mutations,
    pick: async () => { nodes().find(n => n.type === 'input' && n.props.type === 'file').props.onChange({ target: { files: [png()], value: 'photo' } }); await tick(); },
    button: text => nodes().find(n => n.type === 'button' && [n.props.children].flat(Infinity).includes(text)),
    submit: async () => { nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await mutations[0].promise; flush(); },
    close: () => { open = false; flush(); },
  };
}

test('sheet allows optional no-photo submit, preview/remove, failed preparation retry', async () => {
  const empty = sheetHarness(); await empty.submit(); assert.equal(empty.calls.find(c => c[0] === 'manual')[2], undefined);
  const x = sheetHarness({ decodeFail: true }); await x.pick();
  assert.ok(x.button('Thử xử lý ảnh lại'));
  assert.equal(x.nodes().find(n => n.type === 'button' && n.props.type === 'submit').props.disabled, true);
  x.options.decodeFail = false; x.button('Thử xử lý ảnh lại').props.onClick(); await x.tick();
  assert.ok(x.nodes().some(n => n.type === 'img' && n.props.src.startsWith('blob:')));
  x.button('Bỏ ảnh').props.onClick(); x.flush();
  assert.equal(x.nodes().some(n => n.type === 'img'), false); assert.equal(x.revoked.length, 1);
});

test('sheet revokes prepared preview when closed', async () => {
  const x = sheetHarness(); await x.pick(); x.close(); x.flush();
  assert.equal(x.revoked.length, 1);
  assert.equal(x.nodes().some(n => n.type === 'img'), false);
});

test('sheet retries failed upload without sending ml first; unclear POST blocks duplicate submit', async () => {
  const x = sheetHarness({ uploadFail: true }); await x.pick(); await x.submit();
  assert.equal(x.calls.some(c => c[0] === 'manual'), false);
  assert.ok(x.button('Thử gửi lại')); x.options.uploadFail = false; await x.submit();
  assert.equal(x.calls.find(c => c[0] === 'manual')[2], 'proof');
  const unclear = sheetHarness({ postFail: true }); await unclear.pick(); await unclear.submit();
  assert.ok(unclear.button('Đóng và kiểm tra lượt đã gửi'));
  await unclear.submit(); assert.equal(unclear.calls.filter(c => c[0] === 'manual').length, 1);
});
