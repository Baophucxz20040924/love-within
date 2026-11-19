'use strict';
const assert = require('node:assert/strict');
const { loader } = require('./harness.cjs');
async function tests() {
  const actions = [], logs = [], timers = [], cleared = [], requests = [];
  const env = { beeknoee: { apiKey: 'synthetic-test-only', baseUrl: 'https://unused.invalid', chatModel: 'fixture', chatTimeoutMs: 45000 } };
  const load = loader({ 'config/env.ts': { env }, 'utils/logger.ts': { logger: { warn: (...args) => logs.push(args) } } }, {
    AbortController,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => cleared.push(timer),
    fetch: async (url, req) => { requests.push(req); const action = actions.shift(); assert(action, 'unexpected fetch'); return action(req); },
  });
  const adapter = new (load('integrations/ai/BeeknoeeChatAdapter.ts').BeeknoeeChatAdapter)();
  const req = { messages: [{ role: 'user', content: 'PRIVATE-CANARY' }], maxTokens: 1800, temperature: 0.7, json: true };
  const ok = (content = '{}', finish_reason = 'stop', refusal) => ({ ok: true, json: async () => ({ choices: [{ message: { content, refusal }, finish_reason }] }) });
  let cancelled = 0;
  const http = status => ({ ok: false, status, body: { cancel: async () => { cancelled++; } } });
  actions.push(() => ok());
  assert.equal((await adapter.complete(req)).finishReason, 'stop'); assert.equal(timers.at(-1).ms, 45000);
  for (const timeoutMs of [1000, 90000]) {
    actions.push(() => ok()); await adapter.complete({ ...req, timeoutMs }); assert.equal(timers.at(-1).ms, Math.min(timeoutMs, 45000));
  }
  for (const [status, code, retryable] of [[429, 'rate_limit', true], [503, 'upstream', true], [401, 'auth', false], [403, 'auth', false], [400, 'rejected', false]]) {
    const n = requests.length; actions.push(() => http(status));
    await assert.rejects(adapter.complete({ ...req, retry: false }), e => e.code === code && e.retryable === retryable && e.status === status);
    assert.equal(requests.length - n, 1);
  }
  actions.push(() => http(503), () => ok()); await adapter.complete(req); assert.equal(cancelled, 6);
  actions.push(() => { throw Error('PRIVATE-CANARY'); }, () => ok()); await adapter.complete(req);
  actions.push(() => { timers.at(-1).fn(); throw Error('PRIVATE-CANARY'); });
  await assert.rejects(adapter.complete(req), e => e.code === 'timeout' && !e.retryable);
  actions.push(() => ({ ok: true, json: async () => { throw SyntaxError('PRIVATE-CANARY'); } }));
  await assert.rejects(adapter.complete({ ...req, retry: false }), e => e.code === 'invalid_response');
  actions.push(() => ({ ok: true, json: async () => ({ choices: [] }) }));
  await assert.rejects(adapter.complete({ ...req, retry: false }), e => e.code === 'invalid_response');
  actions.push(() => ok(''));
  await assert.rejects(adapter.complete({ ...req, retry: false }), e => e.code === 'empty_response');
  for (const reason of ['length', 'content_filter']) {
    actions.push(() => ok(null, reason)); assert.equal((await adapter.complete(req)).finishReason, reason);
  }
  actions.push(() => ok(null, 'stop', 'PRIVATE-CANARY')); assert.equal((await adapter.complete(req)).refused, true);
  actions.push(() => ok('{}', 'PRIVATE-CANARY')); assert.equal((await adapter.complete(req)).finishReason, 'other');
  env.beeknoee.apiKey = ''; await assert.rejects(adapter.complete(req), e => e.code === 'configuration');
  assert.equal(actions.length, 0); assert.equal(cleared.length, timers.length);
  assert(!JSON.stringify(logs).includes('PRIVATE-CANARY'));
  console.log('PASS chat adapter: classified failures, cancellation, finish/refusal metadata, optional retry/timeout and safe logs (stub fetch only)');
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
