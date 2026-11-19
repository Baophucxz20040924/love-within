'use strict';
const assert = require('node:assert/strict');
const { loader } = require('./harness.cjs');
const canary = 'PRIVATE-CONTENT-MUST-NOT-BE-LOGGED';
const decision = { emotion: 'thoughtful', reply: 'Tôi vẫn đang nghe.', trustDelta: 2, offerCurrentSecret: false, endConversation: false,
  contextUpdate: { summary: 'Đang trò chuyện.', facts: [], openThreads: [] } };
function fixture() {
  let now = 0;
  const requests = [], logs = [], actions = [];
  const env = { aiChatProvider: 'beeknoee', beeknoee: { chatTimeoutMs: 45000 } };
  const load = loader({
    'config/env.ts': { env, isProd: false },
    'utils/logger.ts': { logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) } },
    'integrations/index.ts': { getChat: () => ({ complete: async req => {
      requests.push(req); const action = actions.shift(); assert(action, 'unexpected extra attempt');
      return action(req);
    } }) },
  }, { Date: class extends Date { static now() { return now; } } });
  return { env, requests, logs, actions, load, advance: ms => { now += ms; },
    ai: load('services/scamGame/ai.ts'), rules: load('services/scamGame/rules.ts'),
    Error: load('integrations/ai/ChatProvider.ts').ChatProviderError };
}
const response = (value = decision, extra = {}) => ({ text: JSON.stringify(value), ...extra });
async function tests() {
  const f = fixture(), match = f.rules.newMatch();
  f.actions.push(() => response());
  assert.equal((await f.ai.scamDecision(match, 'hi')).reply, decision.reply);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].retry, false); assert.equal(f.requests[0].timeoutMs, 45000);
  f.actions.push(() => ({ text: '```json\n' + JSON.stringify(decision) + '\n```' }));
  await f.ai.scamDecision(match, 'hi'); assert.equal(f.requests.length, 2);
  for (const first of [
    { text: canary }, response({ ...decision, contextUpdate: null }),
    response({ ...decision, emotion: undefined }), response({ ...decision, emotion: 'rage' }),
    response({ ...decision, offerCurrentSecret: true }), response(decision, { finishReason: 'length' }),
    { text: 'prefix ' + JSON.stringify(decision) }, { text: JSON.stringify(decision) + JSON.stringify(decision) },
  ]) {
    const before = f.requests.length, snapshot = JSON.stringify(match);
    f.actions.push(() => first, () => response());
    await f.ai.scamDecision(match, canary);
    assert.equal(f.requests.length - before, 2); assert.equal(JSON.stringify(match), snapshot);
    assert(f.requests.at(-1).messages[0].content.includes('SỬA ĐỊNH DẠNG'));
    assert(!f.requests.at(-1).messages[0].content.includes(canary));
  }
  f.actions.push(() => ({ text: canary }), () => ({ text: canary }));
  await assert.rejects(f.ai.scamDecision(match, 'hi'), e => e.code === 'SCAM_AI_UNAVAILABLE' && e.message.includes('định dạng') && !e.message.includes(canary));
  for (const [code, retryable] of [['timeout', false], ['configuration', false], ['auth', false], ['rejected', false]]) {
    const before = f.requests.length;
    f.actions.push(() => { throw new f.Error(canary, retryable, code); });
    await assert.rejects(f.ai.scamDecision(match, 'hi'), e => e.code === 'SCAM_AI_UNAVAILABLE' && !e.message.includes(canary));
    assert.equal(f.requests.length - before, 1);
  }
  for (const result of [response(decision, { refused: true }), response(decision, { finishReason: 'content_filter' }), { text: 'x'.repeat(10001) }]) {
    const before = f.requests.length; f.actions.push(() => result);
    await assert.rejects(f.ai.scamDecision(match, 'hi')); assert.equal(f.requests.length - before, 1);
  }
  const before = f.requests.length;
  f.actions.push(() => { f.advance(44000); throw new f.Error(canary, true, 'upstream'); }, () => response());
  await f.ai.scamDecision(match, 'hi');
  assert.equal(f.requests.length - before, 2); assert.equal(f.requests.at(-1).timeoutMs, 31000);
  assert(!f.requests.at(-1).messages[0].content.includes('SỬA ĐỊNH DẠNG'));
  f.actions.push(() => { f.advance(74500); return { text: canary }; });
  await assert.rejects(f.ai.scamDecision(match, 'hi')); assert.equal(f.actions.length, 0);
  f.actions.push(() => { f.advance(75001); return response(); });
  await assert.rejects(f.ai.scamDecision(match, 'hi'), e => e.message.includes('quá lâu'));
  f.env.beeknoee.chatTimeoutMs = 2000;
  f.actions.push(() => { f.advance(1500); return { text: canary }; }, () => response());
  await f.ai.scamDecision(match, 'hi'); assert.equal(f.requests.at(-1).timeoutMs, 2000);
  assert(!JSON.stringify(f.logs).includes(canary));
  assert(f.logs.some(([, data]) => data.outcome === 'recovered'));
  assert(f.logs.some(([, data]) => data.code === 'schema'));
  assert(f.logs.some(([, data]) => data.code === 'disclosure'));

  // Repair is inside one reserved service operation, never a second user POST.
  const g = fixture(); let stored = { _id: 'u', revision: 0, ruleVersion: 1, bestScore: 0, wins: 0, completed: 0,
    match: g.rules.newMatch(), pending: null, receipts: [] };
  const service = loader({
    'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1 },
    'repositories/scamGame.repository.ts': { scamGameRepository: { get: async () => structuredClone(stored), cas: async (old, next) => {
      if (stored.revision !== old.revision) return false;
      stored = structuredClone({ ...next, revision: old.revision + 1 }); return true;
    } } },
    'repositories/friendSafety.repository.ts': { friendBlockRepository: {} }, 'services/profile.service.ts': { profileService: {} },
    'config/env.ts': { env: g.env }, 'services/scamGame/ai.ts': g.ai,
  })('services/scamGame.service.ts').scamGameService;
  const op = { operationId: 'single-op', expectedRevision: 0, matchId: stored.match.id };
  const bubbles = stored.match.messages.length;
  g.actions.push(() => ({ text: 'invalid' }), () => response());
  await service.message('u', op, 'hi');
  assert.equal(stored.match.messages.length, bubbles + 2); assert.equal(stored.match.turns, 1);
  assert.equal(stored.match.emotion, 'thoughtful');
  assert.equal(stored.match.trust, 32); assert.equal(stored.pending, null); assert.equal(stored.receipts.length, 1);
  await service.message('u', op, 'hi'); assert.equal(g.requests.length, 2);
  const beforeFailure = JSON.stringify(stored.match);
  g.actions.push(() => ({ text: 'invalid' }), () => ({ text: 'still invalid' }));
  await assert.rejects(service.message('u', { ...op, operationId: 'failed-op', expectedRevision: stored.revision }, 'fail'));
  assert.equal(JSON.stringify(stored.match), beforeFailure); assert.equal(stored.pending, null);
  let finishRepair;
  g.actions.push(() => ({ text: 'invalid' }), () => new Promise(resolve => { finishRepair = resolve; }));
  const held = service.message('u', { ...op, operationId: 'held-op', expectedRevision: stored.revision }, 'held');
  await new Promise(resolve => setImmediate(resolve)); assert(finishRepair);
  await service.stop('u', { ...op, operationId: 'stop-op', expectedRevision: stored.revision });
  finishRepair(response({ ...decision, emotion: 'angry' })); await assert.rejects(held, e => e.code === 'SCAM_STATE_CHANGED');
  assert.equal(stored.match.emotion, 'thoughtful', 'late repair does not overwrite stopped emotion');
  assert.equal(stored.match.status, 'stopped'); assert.equal(stored.match.turns, 1);

  const h = fixture(), hm = h.rules.newMatch(), resolvers = [];
  for (let i = 0; i < 4; i++) h.actions.push(() => ({ text: 'invalid' }));
  for (let i = 0; i < 4; i++) h.actions.push(() => new Promise(resolve => resolvers.push(resolve)));
  const pending = Array.from({ length: 4 }, () => h.ai.scamDecision(hm, 'held'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolvers.length, 4);
  await assert.rejects(h.ai.scamDecision(hm, 'fifth'), e => e.code === 'SCAM_AI_BUSY');
  resolvers.forEach(resolve => resolve(response())); await Promise.all(pending);
  assert.equal(h.requests.length, 8);
  console.log('PASS scam reliability: bounded repair/provider attempts, deadline, strict contract, private diagnostics, concurrency and single CAS commit/replay/stop fence');
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
