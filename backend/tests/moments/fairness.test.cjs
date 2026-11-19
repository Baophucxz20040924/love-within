'use strict';
// Offline only: execute the actual job with fail-closed repository/provider mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '../../src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Set, Map,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`); return mocks[name]; },
  }, { filename });
  return mod.exports;
}
const dates = load('utils/date.ts');
const now = new Date('2026-11-18T12:00:00Z');
function harness(count) {
  let couples = Array.from({ length: count }, (_, i) => ({ _id: i + 1, timezone: 'UTC' }));
  const calls = { pages: [], creates: [], warnings: [], due: [] };
  const saved = new Set();
  let failure = null;
  const repo = {
    existingDays: async pairs => {
      if (failure === 'existing') throw new Error('existing unavailable');
      return new Set(pairs.map(p => `${p.coupleId}|${p.localDate}`).filter(k => saved.has(k)));
    },
    createDays: async missing => {
      if (failure === 'create') throw new Error('create unavailable');
      calls.creates.push(missing.map(p => ({ ...p })));
      for (const p of missing) saved.add(`${p.coupleId}|${p.localDate}`);
      return missing.length;
    },
    listDueToNotify: async (...args) => { calls.due.push(args); return []; },
  };
  const { duoMomentPromptJob: job } = load('services/jobs/duoMomentPrompt.job.ts', {
    '../realtimeAudience.service.js': { realtimeAudience: {} },
    '../../repositories/couple.repository.js': { coupleRepository: {
      listActivePage: async (after, limit) => {
        calls.pages.push({ after, limit });
        if (failure === 'page') throw new Error('page unavailable');
        return couples.filter(c => after === null || c._id > after).slice(0, limit);
      },
    } },
    '../../repositories/moment.repository.js': { momentRepository: repo },
    '../../utils/date.js': dates,
    '../../utils/logger.js': { logger: { warn: (...args) => calls.warnings.push(args) } },
    '../moment.service.js': { newMomentDay: (coupleId, localDate, timezone) => ({ coupleId, localDate, timezone }) },
    '../notification.service.js': { notificationService: {} },
  });
  return { job, calls, saved, fail: value => { failure = value; },
    setCouples: value => { couples = value; },
    get couples() { return couples; },
  };
}

test('20,001 couples: bounded first run then remaining schedule, wrap without duplicate days', async () => {
  const h = harness(20001);
  assert.equal(await h.job.run(now), 20000);
  assert.equal(h.calls.pages.length, 100);
  assert.equal(h.saved.has('20001|2026-11-18'), false);
  assert.equal(await h.job.run(now), 1);
  assert.equal(h.calls.pages[100].after, 20000);
  assert.equal(h.saved.size, 20001);
  assert.equal(await h.job.run(now), 0);
  assert.equal(h.calls.pages[101].after, null);
  assert.ok(h.calls.pages.every(p => p.limit === 200));
  assert.equal(h.calls.due.length, 3, 'scan cap must not skip the separate announcement pass');
});

test('small population ends traversal rather than looping in one run; exact-page exhaustion resets', async () => {
  for (const count of [0, 1, 199, 200, 400]) {
    const h = harness(count);
    assert.equal(await h.job.run(now), count);
    const expectedPages = Math.floor(count / 200) + 1;
    assert.equal(h.calls.pages.length, expectedPages);
    assert.equal(await h.job.run(now), 0);
    assert.equal(h.calls.pages[expectedPages].after, null);
  }
});

test('page checkpoint advances only after success and failed pages are retried', async () => {
  for (const failure of ['page', 'existing', 'create']) {
    const h = harness(20001);
    await h.job.run(now);
    h.fail(failure);
    await assert.rejects(h.job.run(now), /unavailable/);
    const failedPage = h.calls.pages.at(-1);
    assert.equal(failedPage.after, 20000);
    h.fail(null);
    assert.equal(await h.job.run(now), 1);
    assert.equal(h.calls.pages.at(-1).after, 20000);
    assert.equal(h.saved.size, 20001);
  }
});

test('deleted cursor records and late inserts do not prevent continuation or subsequent wrap', async () => {
  const h = harness(20001);
  await h.job.run(now);
  h.setCouples(h.couples.filter(c => c._id !== 20000).concat({ _id: 20002, timezone: 'UTC' }));
  assert.equal(await h.job.run(now), 2);
  assert.equal(h.saved.has('20001|2026-11-18'), true);
  assert.equal(h.saved.has('20002|2026-11-18'), true);
  h.setCouples([{ _id: 0, timezone: 'UTC' }, ...h.couples]);
  assert.equal(await h.job.run(now), 1);
  assert.equal(h.saved.has('0|2026-11-18'), true);
});

test('continuation uses current run date and frozen policy timezone across midnight', async () => {
  const h = harness(20001);
  h.setCouples(h.couples.map(c => c._id === 20001
    ? { ...c, timezone: 'UTC', dailyRewardPolicy: { timezone: 'Pacific/Kiritimati' } } : c));
  await h.job.run(new Date('2026-11-18T09:59:00Z'));
  await h.job.run(new Date('2026-11-18T10:01:00Z'));
  assert.equal(h.saved.has('20001|2026-11-19'), true);
  assert.equal(h.saved.has('20001|2026-11-18'), false);
  assert.equal(h.calls.creates.at(-1)[0].timezone, 'Pacific/Kiritimati');
});
