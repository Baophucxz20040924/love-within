'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loader } = require('./harness.cjs');
const load = loader({ 'config/env.ts': { env: { aiChatProvider: 'mock' }, isProd: false }, 'integrations/index.ts': { getChat: () => { throw Error('No provider'); } }, 'utils/logger.ts': { logger: {} } });
const rules = load('services/scamGame/rules.ts'), scenarios = load('services/scamGame/scenarios.ts'), ai = load('services/scamGame/ai.ts');
const decision = { emotion: 'curious', reply: 'Tôi đang nghe.', trustDelta: 0, offerCurrentSecret: false, endConversation: false, contextUpdate: { summary: '', facts: [], openThreads: [] } };
async function tests() {
  let maxPrompt = 0;
  for (const id of ['bank', 'identity', 'social']) {
    const match = rules.newMatch(undefined, id), scenario = scenarios.scenarioFor(match);
    assert.equal(scenario.steps.length, id === 'identity' ? 2 : 3);
    assert.equal(scenario.steps.reduce((n, s) => n + s.points, 0), 600);
    assert.equal(Object.keys(match.secrets).length, scenario.steps.length);
    if (id === 'identity') { assert.match(match.secrets.identityCode, /^SIM-ID-/); assert.equal(scenarios.normalizeAnswer(match.secrets.dob, 'date'), match.secrets.dob); }
    if (id === 'social') { assert.equal(new Set(match.scenario.questions).size, 2); assert.match(match.secrets.account, /^SIM-USER-/); }
    for (const c of load('services/scamGame/characters.ts').SCAM_CHARACTERS) {
      match.character = { id: c.id, name: c.name, emoji: c.emoji, description: c.description };
      match.runtimeContext.profile = { id: c.id, name: c.name, persona: c.persona }; match.runtimeContext.scene = c.scene;
      const prompt = ai.scamPrompt(match, 'hello')[0].content;
      maxPrompt = Math.max(maxPrompt, prompt.length);
      assert(prompt.length <= 8500, `${id}/${c.name}: ${prompt.length}`);
    }
    for (const step of scenario.steps) {
      match.stage = step.id; match.trust = step.gate;
      const prompt = ai.scamPrompt(match, Object.values(match.secrets).join(' '));
      for (const [key, value] of Object.entries(match.secrets)) {
        assert.equal(prompt[0].content.split(value).length - 1, key === step.id ? 1 : 0);
        assert(!JSON.stringify(prompt.slice(1)).includes(value));
        if (key !== step.id) assert.throws(() => rules.validateDisclosure(match, { ...decision, reply: value }));
      }
      rules.validateDisclosure(match, { ...decision, reply: match.secrets[step.id], offerCurrentSecret: true });
      assert.throws(() => rules.validateDisclosure(match, { ...decision, reply: match.secrets[step.id] }));
    }
    let stored = { _id: 'u', revision: 0, ruleVersion: 1, bestScore: 0, wins: 0, completed: 0, match: rules.newMatch(undefined, id), pending: null, receipts: [] };
    const service = loader({ 'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1 },
      'repositories/scamGame.repository.ts': { scamGameRepository: { get: async () => structuredClone(stored), cas: async (old, next) => { if (old.revision !== stored.revision) return false; stored = structuredClone({ ...next, revision: old.revision + 1 }); return true; } } },
      'repositories/friendSafety.repository.ts': { friendBlockRepository: {} }, 'services/profile.service.ts': { profileService: {} },
      'config/env.ts': { env: {} }, 'services/scamGame/ai.ts': { isScamMock: () => true },
    })('services/scamGame.service.ts').scamGameService;
    const op = () => ({ operationId: randomUUID(), expectedRevision: stored.revision, matchId: stored.match.id });
    for (const step of scenario.steps) {
      const operation = op(), original = stored.match.secrets[step.id];
      const value = step.policy === 'date' ? original.split('-').reverse().join('/') : step.policy === 'name' ? original.toUpperCase().replaceAll(' ', '   ').normalize('NFD') : original;
      await assert.rejects(service.verify('u', operation, step.id, 'wrong'), e => e.code === 'SCAM_INCORRECT');
      await service.verify('u', operation, step.id, value); // Verify before disclosure remains supported.
      const revision = stored.revision;
      await service.verify('u', operation, step.id, value); assert.equal(stored.revision, revision);
      if (value !== original) await assert.rejects(service.verify('u', operation, step.id, original), e => e.status === 409, 'raw fingerprint remains distinct');
    }
    assert.equal(stored.match.score, 600); assert.equal(stored.match.status, 'won'); assert.equal(stored.wins, 1); assert.equal(stored.completed, 1); assert(!stored.match.runtimeContext);
    const view = JSON.stringify(rules.playerView(stored, true));
    for (const value of Object.values(stored.match.secrets)) assert(!view.includes(value));
    assert(!view.includes('policy')); assert(!view.includes('gate')); assert(!view.includes('premise'));
  }
  for (const date of ['2023-02-29', '31/04/2000', '2000-13-01', '01/01/0000', '1/1/2000']) assert.equal(scenarios.normalizeAnswer(date, 'date'), null);
  assert.equal(scenarios.normalizeAnswer('29/02/2000', 'date'), '2000-02-29');
  assert.equal(scenarios.normalizeAnswer(' MÈO   MÂY '.normalize('NFD'), 'name'), 'mèo mây');
  const m = rules.newMatch(undefined, 'social'); m.stage = 'recoveryQuestion1'; m.trust = 100;
  const future = m.secrets.recoveryQuestion2.toUpperCase().replaceAll(' ', '\n  ').normalize('NFD');
  assert.throws(() => rules.validateDisclosure(m, { ...decision, reply: future }));
  assert.equal(rules.redactSecrets(future, m), '[thông tin đã ẩn]');
  const identity = rules.newMatch(undefined, 'identity');
  assert.equal(rules.redactSecrets(identity.secrets.dob.split('-').reverse().join('/'), identity), '[thông tin đã ẩn]');
  const legacy = rules.newMatch(undefined, 'bank'); delete legacy.scenario;
  const before = JSON.stringify(legacy); assert.equal(scenarios.scenarioFor(legacy).id, 'bank'); assert.equal(JSON.stringify(legacy), before);
  for (const bad of [null, {}, { id: 'bank', version: 2, questions: [] }, { id: 'social', version: 1, questions: ['pet', 'pet'] }, { id: 'unknown', version: 1, questions: [] }]) {
    legacy.scenario = bad; assert.throws(() => scenarios.scenarioFor(legacy), e => e.code === 'SCAM_SCENARIO_INVALID');
  }
  console.log(`PASS scenarios: 3 catalogs, server scoring/replay, legacy/fail-closed, normalization/redaction, 40x3 prompt budget (max ${maxPrompt}), no provider/DB`);
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
