'use strict';
// Synthetic bcrypt microbenchmark only. No server, config, DB, credentials or network.
const bcrypt = require('bcryptjs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../src/services/privacyLock.service.ts'), 'utf8');
const dummy = /const DUMMY_HASH = '([^']+)'/.exec(source)[1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  assert.equal(bcrypt.getRounds(dummy), 11);
  const real = await bcrypt.hash('001234', 11);
  const rows = [];
  for (const variant of ['baseline-cold', 'new-cold', 'baseline-warm', 'new-warm']) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable(); await sleep(20);
      const cpu = process.cpuUsage(), start = performance.now();
      const padding = variant === 'baseline-cold' ? await bcrypt.hash('privacy-lock-dummy-verifier', 11) : dummy;
      const result = await Promise.all([bcrypt.compare('001234', real), bcrypt.compare('001234', padding)]);
      const used = process.cpuUsage(cpu), wallMs = performance.now() - start;
      assert.deepEqual(result, [true, false]);
      await sleep(20); delay.disable();
      samples.push({ wallMs: Math.round(wallMs), cpuMs: Math.round((used.user + used.system) / 1000), eventLoopMaxMs: Math.round(delay.max / 1e6) });
    }
    rows.push({ variant, samples, extraHashCalls: variant === 'baseline-cold' ? 1 : 0, compareCalls: 2 });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, samplesPerVariant: 3, rows,
    limitation: 'Sequential synthetic bcrypt-only measurements; no HTTP/DB latency, no production CPU percentage or server throughput claim. Service model-call counts are asserted in service.cjs.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
