'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loader } = require('./harness.cjs');
const rules = loader()('services/scamGame/rules.ts');
const positive = { emotion: 'happy', reply: 'Được, tôi đang nghe.', trustDelta: 100, offerCurrentSecret: false, endConversation: false, contextUpdate: { summary: 'Nhớ ngắn', facts: [], openThreads: [] } };
const offer = m => ({ ...positive, offerCurrentSecret: true, reply: `Thông tin của tôi là ${m.secrets[m.stage]}.` });
const hangup = { ...positive, emotion: 'neutral', reply: 'Tôi không muốn nói tiếp. Tạm biệt.', endConversation: true };
function player() { return { _id: '000000000000000000000001', revision: 0, ruleVersion: 1, bestScore: 0, wins: 0, completed: 0, match: null, pending: null, receipts: [] }; }
const clone = structuredClone;
function fixture() {
  let stored = player(), decision = async m => offer(m);
  const load = loader({
    'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1 },
    'services/scamGame/rules.ts': { ...rules, newMatch: previous => rules.newMatch(previous, 'bank') },
    'repositories/scamGame.repository.ts': { scamGameRepository: { get: async () => clone(stored), cas: async (old, next) => {
      if (stored.revision !== old.revision) return false;
      stored = clone({ ...next, revision: old.revision + 1 }); return true;
    } } },
    'repositories/friendSafety.repository.ts': { friendBlockRepository: {} },
    'services/profile.service.ts': { profileService: {} },
    'config/env.ts': { env: { beeknoee: { chatTimeoutMs: 1000 } } },
    'services/scamGame/ai.ts': { isScamMock: () => true, scamDecision: (...args) => decision(...args) },
  });
  const service = load('services/scamGame.service.ts').scamGameService;
  const op = () => ({ operationId: randomUUID(), expectedRevision: stored.revision, ...(stored.match ? { matchId: stored.match.id } : {}) });
  return { service, op, get: () => stored, set: p => { stored = p; }, decide: fn => { decision = fn; } };
}
async function tests() {
  let previous;
  for (let i = 0; i < 50; i++) {
    const m = rules.newMatch(previous, 'bank'); assert.notEqual(m.character.id, previous); previous = m.character.id;
    assert.match(m.secrets.account, /^SIM-[A-F0-9]{4}$/); assert.match(m.secrets.password, /^P-[A-HJ-NP-Z2-9]{6}$/); assert.equal(m.secrets.account.length, 8); assert.equal(m.secrets.password.length, 8); assert.match(m.secrets.otp, /^\d{6}$/);
  }
  const { SCAM_EMOTIONS } = loader()('services/scamGame/emotions.ts');
  assert.equal(SCAM_EMOTIONS.length, 16);
  for (const emotion of SCAM_EMOTIONS) {
    const emotional = rules.newMatch(undefined, 'bank'); assert.equal(emotional.emotion, 'neutral'); emotional.trust = 90;
    rules.applyDecision(emotional, 'state', { ...positive, emotion, trustDelta: 0 });
    assert.equal(emotional.emotion, emotion); assert.equal(emotional.status, 'active'); assert.equal(emotional.trust, 90);
    assert.equal(rules.playerView({ ...player(), match: emotional }, true).match.emotion, emotion);
  }
  for (const emotion of [undefined, null, 'rage', 'toString', 1, {}]) {
    const old = rules.newMatch(undefined, 'bank'); old.emotion = emotion;
    const saved = JSON.stringify(old);
    assert.equal(rules.playerView({ ...player(), match: old }, true).match.emotion, 'neutral');
    assert.equal(JSON.stringify(old), saved, 'legacy view never mutates');
    assert.throws(() => rules.applyDecision(old, 'invalid', { ...positive, emotion }));
    assert.equal(JSON.stringify(old), saved, 'invalid emotion never mutates');
  }
  const roster = loader()('services/scamGame/characters.ts').SCAM_CHARACTERS;
  assert.equal(roster.length, 40); assert.equal(new Set(roster.map(c => c.id)).size, 40);
  const source = require('../../../list-charactor.json').characters;
  for (const c of roster) {
    assert.equal(c.name, c.sourceId === 31 ? 'Captain America' : source[c.sourceId - 1].name);
    assert.equal(c.kind, c.sourceId === 17 ? 'fictional_character' : source[c.sourceId - 1].type);
    assert(c.persona.length <= 1600, `profile bound: ${c.name} (${c.persona.length})`);
    for (const section of ['Kiến thức nền:', 'Cách nói:', 'Sở thích trong vai:', 'Tính cách trong vai:', 'Phản ứng trong vai:', 'Điều không thích trong vai:', 'Sắc thái cảm xúc:', 'Mới gọi:', 'thoải mái:', 'bối rối:', 'hơi bực:']) {
      assert(c.persona.includes(section), `${c.name}: ${section}`);
    }
    assert(c.persona.includes('là sáng tác')); assert(c.persona.includes('Sở thích không là nút tự động đồng ý'));
    assert(c.scene.includes('Người chơi chủ động gọi đến'));
  }
  assert.equal(new Set(roster.map(c => c.persona.split('Sắc thái cảm xúc: ')[1])).size, 40);
  assert.equal(roster.find(c => c.sourceId === 35).id, 'luffy');
  const rhythms = roster.map(c => c.persona.match(/Nhịp tin tưởng trong vai: (Cởi mở|Điềm tĩnh|Bộc trực|Kín đáo):/)?.[1]);
  assert(rhythms.every(Boolean)); assert.equal(new Set(rhythms).size, 4);
  assert.equal(new Set(roster.map(c => c.persona.split('Nhịp tin tưởng trong vai: ')[1])).size, 40);
  const m = rules.newMatch(undefined, 'bank'); assert.equal(m.trust, 30);
  const other = rules.newMatch(undefined, 'bank'), original = JSON.stringify(roster);
  assert.notEqual(m.runtimeContext, other.runtimeContext); assert.notEqual(m.runtimeContext.memory, other.runtimeContext.memory);
  assert(!m.character.persona); assert(!m.memory);
  rules.applyDecision(m, 'context', { ...positive, trustDelta: 0, contextUpdate: { summary: m.secrets.otp, facts: ['Người gọi tự nhận là bạn', 'Người gọi tự nhận là bạn'], openThreads: ['Hỏi mục đích'] } }, 'correlation');
  assert.equal(m.runtimeContext.memory.facts.length, 1); assert(!m.runtimeContext.memory.summary.includes(m.secrets.otp));
  assert.equal(m.messages.at(-2).operationId, 'correlation'); assert.equal(JSON.stringify(roster), original);
  const immutable = JSON.stringify(m);
  assert.throws(() => rules.applyDecision(m, 'invalid', { ...positive, offerCurrentSecret: true }));
  assert.equal(JSON.stringify(m), immutable, 'invalid disclosure does not mutate context/trust/chat');
  const restored = clone(m);
  rules.applyDecision(restored, 'đính chính', { ...positive, trustDelta: 0, contextUpdate: { summary: 'Đã đính chính', facts: ['Người gọi nói chưa từng gặp'], openThreads: [] } });
  assert.equal(restored.runtimeContext.memory.facts.length, 1); assert(!restored.runtimeContext.memory.facts.includes('Người gọi tự nhận là bạn'));
  assert.equal(m.runtimeContext.memory.facts[0], 'Người gọi tự nhận là bạn');
  const legacy = rules.newMatch(undefined, 'bank'); delete legacy.runtimeContext; legacy.character.persona = 'Vai cũ'; legacy.memory = 'Chuyện cũ';
  rules.ensureContext(legacy); assert.equal(legacy.runtimeContext.profile.persona, 'Vai cũ'); assert.equal(legacy.runtimeContext.memory.summary, 'Chuyện cũ'); assert(!legacy.memory);
  assert(legacy.runtimeContext.scene.includes('không đổi địa điểm'));
  const activeSnapshot = rules.newMatch(undefined, 'bank'); activeSnapshot.runtimeContext.profile.persona = 'Hồ sơ đã clone từ bản trước';
  activeSnapshot.secrets = { account: 'SIM-012345ABCDEF', password: 'PROP-legacy-long-value', otp: '001234' };
  const savedSecrets = JSON.stringify(activeSnapshot.secrets);
  const savedContext = JSON.stringify(activeSnapshot.runtimeContext);
  rules.ensureContext(activeSnapshot);
  assert.equal(JSON.stringify(activeSnapshot.runtimeContext), savedContext, 'active profile snapshot is not replaced by expanded roster');
  rules.applyDecision(activeSnapshot, 'legacy', offer(activeSnapshot));
  assert.equal(JSON.stringify(activeSnapshot.secrets), savedSecrets, 'active values are never regenerated');
  assert(activeSnapshot.messages.at(-1).text.includes('SIM-012345ABCDEF'));
  assert.equal(rules.nextTrust({ trust: 99 }, 100), 100);
  assert.equal(rules.nextTrust({ trust: 1 }, -100), 0);
  for (const [stage, gate] of Object.entries(rules.SCAM_BALANCE.gates)) {
    const boundary = rules.newMatch(undefined, 'bank'); boundary.stage = stage; boundary.trust = gate - 21;
    assert.throws(() => rules.validateDisclosure(boundary, offer(boundary)), 'gate uses clamped delta, not raw100');
    boundary.trust++;
    rules.applyDecision(boundary, 'boundary', offer(boundary)); assert.equal(boundary.trust, gate);
  }
  rules.applyDecision(m, 'xin chào', offer(m)); assert.equal(m.trust, 50); assert.equal(m.revealed[0], 'account');
  rules.applyDecision(m, 'xin chào', offer(m)); assert.equal(m.trust, 70);
  for (const [stage, gate] of Object.entries(rules.SCAM_BALANCE.gates)) {
    const below = rules.newMatch(undefined, 'bank'); below.stage = stage; below.trust = gate - 1;
    assert.throws(() => rules.applyDecision(below, 'chưa đủ', { ...offer(below), trustDelta: 0 })); assert.equal(below.revealed.length, 0);
    rules.applyDecision(below, 'vừa đủ', { ...offer(below), trustDelta: 1 }); assert.equal(below.revealed[0], stage);
    const noOffer = rules.newMatch(undefined, 'bank'); noOffer.stage = stage; noOffer.trust = 100;
    rules.applyDecision(noOffer, 'chưa đồng ý', { ...positive, offerCurrentSecret: false }); assert.equal(noOffer.revealed.length, 0);
  }
  const penalty = rules.newMatch(undefined, 'bank'); rules.applyDecision(penalty, 'x', { ...positive, trustDelta: -100 });
  assert.equal(penalty.trust, 18); assert.equal(penalty.status, 'active');
  assert(!('suspicion' in penalty)); assert(!('warned' in penalty));
  for (const trust of [0, 100]) {
    const ended = rules.newMatch(undefined, 'bank'); ended.trust = trust;
    rules.applyDecision(ended, 'x', { ...hangup, offerCurrentSecret: true, trustDelta: 0 });
    assert(!ended.runtimeContext); assert.equal(ended.emotion, 'neutral'); assert.equal(ended.status, 'lost'); assert(ended.endedAt); assert.equal(ended.turns, 1);
    assert.equal(ended.revealed.length, 0, 'hang-up overrides simultaneous offer even at trust100');
    assert(!ended.messages.some(b => b.text.includes(ended.secrets.account)));
    assert.equal(ended.messages.at(-2).text, hangup.reply); assert.equal(ended.messages.at(-1).role, 'system');
  }
  const closing = rules.newMatch(undefined, 'bank');
  rules.applyDecision(closing, 'bye', { ...hangup, offerCurrentSecret: true, reply: `Tạm biệt ${closing.secrets.account} ${closing.secrets.password} ${closing.secrets.otp}` });
  assert(!closing.runtimeContext); for (const value of Object.values(closing.secrets)) assert(!closing.messages.at(-2).text.includes(value));
  const continuing = rules.newMatch(undefined, 'bank'); continuing.trust = 0;
  continuing.suspicion = 100; continuing.warned = true; // Legacy Mixed fields are inert.
  rules.applyDecision(continuing, 'x', { ...positive, trustDelta: -100, reply: 'Bạn vừa nói cúp máy, ngắt liên lạc sao? Tôi vẫn đang nghe.' });
  assert.equal(continuing.status, 'active'); assert.equal(continuing.trust, 0); assert.equal(continuing.endedAt, null);
  for (let i = 0; i < 120; i++) rules.applyDecision(continuing, 'x', positive); assert.equal(continuing.messages.length, 80); assert(continuing.turns > 100);
  const aged = rules.newMatch(undefined, 'bank'); aged.trust = 100; rules.applyDecision(aged, 'x', offer(aged));
  for (let i = 0; i < 90; i++) rules.append(aged, 'user', 'cửa sổ mới');
  assert(!aged.messages.some(m => m.text.includes(aged.secrets.account)));
  rules.applyDecision(aged, 'xin lại', offer(aged)); assert(aged.messages.some(m => m.text.includes(aged.secrets.account))); assert.equal(aged.revealed.length, 1);
  const p = player(); p.match = rules.newMatch(undefined, 'bank'); p.pending = { operationId: 'op', fingerprint: 'private', token: 'private-token', expectedRevision: 0, expiresAt: 3, text: 'draft' };
  p.match.suspicion = 100; p.match.warned = true;
  const view = JSON.stringify(rules.playerView(p, true)); assert(!view.includes('suspicion')); assert(!view.includes('warned')); for (const secret of Object.values(p.match.secrets)) assert(!view.includes(secret));
  assert(!view.includes('private-token')); assert(!view.includes('fingerprint')); assert(!view.includes('persona')); assert(!view.includes('memory'));

  const f = fixture(), s = f.service; let start = f.op(); await s.start('u', start); const character = f.get().match.character.id;
  await s.start('u', start); assert.equal(f.get().revision, 1);
  await assert.rejects(s.start('u', { ...start, expectedRevision: 1 }), e => e.status === 409);
  await assert.rejects(s.verify('u', f.op(), 'password', f.get().match.secrets.password), e => e.status === 409);
  const early = fixture(); await early.service.start('u', early.op());
  await early.service.verify('u', early.op(), 'account', early.get().match.secrets.account);
  assert.equal(early.get().match.score, 100, 'current stage can verify before disclosure');
  const stageScores = [100, 300, 600]; let i = 0;
  for (const stage of ['account', 'password', 'otp']) {
    while (!f.get().match.revealed.includes(stage)) await s.message('u', f.op(), 'nội dung giả lập');
    await assert.rejects(s.verify('u', f.op(), stage, 'sai'), e => e.status === 422);
    const operation = f.op(), value = f.get().match.secrets[stage];
    await s.verify('u', operation, stage, value); await s.verify('u', operation, stage, value);
    assert.equal(f.get().match.score - (f.get().match.bonus ?? 0), stageScores[i++]); assert.equal(f.get().match.emotion, 'happy', 'verification retains emotion');
  }
  const winningTotal = f.get().match.score;
  assert(winningTotal >= 630 && winningTotal <= 750);
  assert(!f.get().match.runtimeContext); assert(!f.get().match.memory);
  assert.equal(f.get().match.status, 'won'); assert.equal(f.get().wins, 1); assert.equal(f.get().completed, 1); assert.equal(f.get().bestScore, winningTotal);
  await assert.rejects(s.verify('u', f.op(), 'otp', f.get().match.secrets.otp), e => e.status === 409);
  await s.start('u', f.op()); assert.notEqual(f.get().match.character.id, character);
  const starts = fixture(); const same = starts.op(); const results = await Promise.allSettled([starts.service.start('u', same), starts.service.start('u', { ...same, operationId: randomUUID() })]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);

  let resolve; f.decide(() => new Promise(r => { resolve = r; })); const turnOp = f.op(), turn = s.message('u', turnOp, 'đợi');
  await new Promise(r => setImmediate(r)); assert(f.get().pending);
  await assert.rejects(s.message('u', turnOp, 'đợi'), e => e.code === 'SCAM_TURN_PENDING');
  await assert.rejects(s.message('u', turnOp, 'khác'), e => e.status === 409);
  await assert.rejects(s.verify('u', f.op(), 'account', 'x'), e => e.code === 'SCAM_TURN_PENDING');
  const stop = f.op(); await s.stop('u', stop); await s.stop('u', stop); assert.equal(f.get().completed, 2); assert(!f.get().match.runtimeContext);
  await s.start('u', f.op()); const fresh = f.get().match.id; resolve(hangup); await assert.rejects(turn, e => e.code === 'SCAM_STATE_CHANGED'); assert.equal(f.get().completed, 2); assert.equal(f.get().match.id, fresh); assert.equal(f.get().match.turns, 0); assert.equal(f.get().match.emotion, 'neutral', 'new match fenced from old emotion');

  const pending = []; f.decide(() => new Promise(r => pending.push(r))); const leaseOp = f.op(); const oldTurn = s.message('u', leaseOp, 'lease'); await new Promise(r => setImmediate(r));
  f.get().pending.expiresAt = 0; const retry = s.message('u', leaseOp, 'lease'); await new Promise(r => setImmediate(r));
  pending[0](hangup); await assert.rejects(oldTurn, e => e.status === 409); assert(f.get().pending); assert.equal(f.get().completed, 2);
  pending[1](positive); await retry; assert.equal(f.get().match.turns, 1); await s.message('u', leaseOp, 'lease'); assert.equal(f.get().match.turns, 1);
  f.decide(async () => { throw Error('provider-failure'); }); const revision = f.get().revision; const before = clone(f.get().match);
  await assert.rejects(s.message('u', f.op(), 'fail')); assert.equal(f.get().pending, null); assert.equal(f.get().revision, revision + 2); assert.deepEqual(f.get().match, before);
  f.decide(async m => offer(m)); while (f.get().match.score === 0) { if (f.get().match.revealed.includes('account')) await s.verify('u', f.op(), 'account', f.get().match.secrets.account); else await s.message('u', f.op(), 'hello'); }
  await s.stop('u', f.op()); assert.equal(f.get().match.score, 100); assert.equal(f.get().bestScore, winningTotal); assert.equal(f.get().wins, 1);
  assert(f.get().receipts.length <= 16);
  const loss = fixture(), ls = loss.service; await ls.start('u', loss.op());
  loss.get().match.suspicion = 100; loss.get().match.warned = true;
  await ls.message('u', loss.op(), 'hello'); assert.equal(loss.get().match.status, 'active');
  await ls.verify('u', loss.op(), 'account', loss.get().match.secrets.account);
  loss.get().match.trust = 100; loss.decide(async () => hangup);
  const lossOp = loss.op(); await ls.message('u', lossOp, 'kết thúc');
  assert.equal(loss.get().match.status, 'lost'); assert.equal(loss.get().match.score, 100);
  assert.equal(loss.get().bestScore, 100); assert.equal(loss.get().completed, 1); assert.equal(loss.get().wins, 0);
  assert.deepEqual(Array.from(loss.get().match.revealed), ['account']);
  assert(!loss.get().match.messages.some(b => b.text.includes(loss.get().match.secrets.password)));
  const lossRevision = loss.get().revision; await ls.message('u', lossOp, 'kết thúc');
  assert.equal(loss.get().revision, lossRevision); assert.equal(loss.get().completed, 1);
  await assert.rejects(ls.message('u', loss.op(), 'nói tiếp'), e => e.status === 409);
  await assert.rejects(ls.verify('u', loss.op(), 'password', loss.get().match.secrets.password), e => e.status === 409);
  await assert.rejects(ls.stop('u', loss.op()), e => e.status === 409);
  await ls.start('u', loss.op()); await ls.message('u', lossOp, 'kết thúc');
  assert.equal(loss.get().match.status, 'active'); assert.equal(loss.get().match.turns, 0); assert.equal(loss.get().completed, 1);
  console.log('PASS scam state: generated props, trust gates, 600 points, structured AI loss/partial stats, legacy compatibility, replay/CAS, bounded storage and stale-worker fences');
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
