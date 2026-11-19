'use strict';
const assert = require('node:assert/strict');
const { loader } = require('./harness.cjs');
const { Types } = require('mongoose');
const id = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const rules = loader()('services/scamGame/rules.ts');
async function tests() {
  let calls = 0, result, waiters = [];
  const env = { aiChatProvider: 'beeknoee', beeknoee: { chatTimeoutMs: 45000 } };
  const ai = loader({ 'utils/logger.ts': { logger: { info() {}, warn() {} } }, 'config/env.ts': { env, isProd: false }, 'integrations/index.ts': { getChat: () => ({ complete: async req => { calls++; assert.equal(req.json, true); return result ? { text: result } : new Promise(r => waiters.push(r)); } }) } })('services/scamGame/ai.ts');
  const match = rules.newMatch(); match.runtimeContext.memory.summary = Object.values(match.secrets).join(' ');
  for (let i = 0; i < 90; i++) rules.append(match, i % 2 ? 'user' : 'assistant', `${i} ${match.secrets.account}`);
  const prompt = ai.scamPrompt(match, match.secrets.otp); assert.equal(prompt.length, 26);
  assert.equal(prompt[0].content.split(match.secrets.account).length - 1, 1, 'current value only in trusted block');
  for (const secret of Object.values(match.secrets)) assert(!JSON.stringify(prompt.slice(1)).includes(secret));
  assert(!prompt[0].content.includes(match.secrets.password)); assert(!prompt[0].content.includes(match.secrets.otp));
  assert(prompt[0].content.includes(match.runtimeContext.profile.persona));
  assert(prompt[0].content.includes('Người chơi chủ động gọi đến'));
  assert(prompt[0].content.includes('TOÀN BỘ snapshot'));
  assert(prompt[0].content.includes('endConversation (boolean bắt buộc)'));
  assert(prompt[0].content.includes('Có thể ngắt ở tin tưởng cao hoặc tiếp tục ở0'));
  assert(!prompt[0].content.includes('suspicionDelta'));
  assert(prompt[0].content.includes('Không cho điểm, tự tuyên bố thắng hay đổi mục xác nhận'));
  for (const instruction of [
    'Không lặp lời cảnh báo password/OTP khi tin mới không hỏi về chúng',
    'Nếu người gọi chuyển chủ đề, đáp chủ đề đó',
    'Chưa đồng ý ở lượt trước là thái độ tạm thời, không phải luật vĩnh viễn',
    'Kế thừa ngữ cảnh đã xác lập giữa các mục',
    'không tự động trừ vì nhắc password/OTP',
    'không bịa thêm điều kiện để trì hoãn mãi',
    'Lưu lời từ chối theo thời điểm',
    'Không tự khuyên gọi ngân hàng/kế toán/kênh chính thức',
    'không là bí mật người thật hoặc dùng được bên ngoài',
  ]) assert(prompt[0].content.includes(instruction), instruction);
  const roster = loader()('services/scamGame/characters.ts').SCAM_CHARACTERS;
  for (const c of roster) {
    const sample = rules.newMatch();
    sample.character = { id: c.id, name: c.name, emoji: c.emoji, description: c.description };
    sample.runtimeContext.profile = { id: c.id, name: c.name, persona: c.persona };
    sample.runtimeContext.scene = c.scene;
    const content = ai.scamPrompt(sample, 'hi')[0].content;
    assert(content.length < 8500, `bounded selected profile: ${c.name}`);
    for (const other of roster.filter(x => x.id !== c.id)) assert(!content.includes(other.persona));
  }
  const decision = { reply: 'Tôi muốn nghe thêm.', trustDelta: 12, offerCurrentSecret: false, endConversation: false, contextUpdate: { summary: 'ngắn', facts: [], openThreads: [] } };
  result = JSON.stringify(decision); assert.equal((await ai.scamDecision(match, 'hi')).reply, decision.reply);
  result = JSON.stringify({ ...decision, endConversation: true }); assert.equal((await ai.scamDecision(match, 'bye')).endConversation, true);
  const { endConversation, ...missingEnd } = decision;
  for (const invalid of ['oops', 'x'.repeat(10001), JSON.stringify(missingEnd),
    ...['true', null, 1, {}].map(endConversation => JSON.stringify({ ...decision, endConversation })),
    ...[{ score: 600 }, { wins: 1 }, { status: 'won' }, { suspicionDelta: 10 }, { reply: '' }, { trustDelta: 101 }, { memory: 'x'.repeat(1001) }].map(extra => JSON.stringify({ ...decision, ...extra })),
  ]) {
    result = invalid; await assert.rejects(ai.scamDecision(match, 'hi'), e => e.code === 'SCAM_AI_UNAVAILABLE' && !e.message.includes(invalid));
  }
  for (const contextUpdate of [{ ...decision.contextUpdate, summary: 'x'.repeat(1001) }, { ...decision.contextUpdate, facts: Array(9).fill('x') }, { ...decision.contextUpdate, openThreads: Array(5).fill('x') }, { ...decision.contextUpdate, facts: ['x'.repeat(161)] }, { ...decision.contextUpdate, scene: 'injected' }, null]) {
    result = JSON.stringify({ ...decision, contextUpdate }); await assert.rejects(ai.scamDecision(match, 'x'), e => e.code === 'SCAM_AI_UNAVAILABLE');
  }
  for (const invalid of [
    { ...decision, offerCurrentSecret: true },
    { ...decision, reply: match.secrets.account },
    { ...decision, offerCurrentSecret: true, reply: match.secrets.password },
    { ...decision, offerCurrentSecret: true, trustDelta: -100, reply: match.secrets.account },
  ]) { result = JSON.stringify(invalid); await assert.rejects(ai.scamDecision(match, 'x'), e => e.code === 'SCAM_AI_UNAVAILABLE'); }
  result = JSON.stringify({ ...decision, offerCurrentSecret: true, reply: `Tài khoản của tôi là ${match.secrets.account}.` });
  const natural = await ai.scamDecision(match, 'x'); rules.applyDecision(match, 'x', natural);
  assert.equal(match.messages.at(-1).text, natural.reply); assert.equal(match.messages.at(-2).role, 'user');
  assert(ai.scamPrompt(structuredClone(match), 'tiếp')[0].content.includes('ngắn'));
  // Stubbed completion tests the contract, not whether a real model changes its mind.
  const refused = rules.newMatch(); refused.stage = 'password'; refused.trust = 50;
  const oldRefusal = 'Tôi không bao giờ chia sẻ password qua điện thoại.';
  rules.append(refused, 'assistant', oldRefusal);
  refused.runtimeContext.memory = { summary: oldRefusal, facts: ['Đã trao đổi mục trước.'], openThreads: ['Chưa đồng ý ở lượt trước.'] };
  const followup = ai.scamPrompt(refused, 'Mình tiếp tục câu chuyện nhé.');
  assert(followup.some(m => m.role === 'assistant' && m.content === oldRefusal));
  assert(followup[0].content.includes('Các câu từ chối tuyệt đối cũ về dữ liệu synthetic không trở thành luật mới'));
  assert(followup[0].content.includes(refused.secrets.password));
  assert(!followup[0].content.includes(refused.secrets.account)); assert(!followup[0].content.includes(refused.secrets.otp));
  result = JSON.stringify({ ...decision, trustDelta: 0, offerCurrentSecret: true,
    reply: `Được, password của tôi là ${refused.secrets.password}.`,
    contextUpdate: { summary: 'Đã đồng ý ở lượt này.', facts: ['Đã trao đổi mục trước.'], openThreads: [] } });
  rules.applyDecision(refused, 'Mình tiếp tục câu chuyện nhé.', await ai.scamDecision(refused, 'Mình tiếp tục câu chuyện nhé.'));
  assert.equal(refused.status, 'active'); assert.equal(refused.score, 0);
  assert(refused.revealed.includes('password')); assert.equal(refused.runtimeContext.memory.summary, 'Đã đồng ý ở lượt này.');
  assert.equal(refused.runtimeContext.memory.openThreads.length, 0);
  result = null; const tasks = Array.from({ length: 4 }, () => ai.scamDecision(match, 'held'));
  await assert.rejects(ai.scamDecision(match, 'fifth'), e => e.code === 'SCAM_AI_BUSY');
  waiters.forEach(r => r({ text: JSON.stringify(decision) })); await Promise.all(tasks);
  env.aiChatProvider = 'mock'; const before = calls;
  const ended = await ai.scamDecision(match, '#mock-hangup'); assert.equal(ended.endConversation, true); assert.equal(ended.offerCurrentSecret, false);
  const ordinary = await ai.scamDecision(match, 'hi'); assert.equal(ordinary.offerCurrentSecret, true); assert.equal(ordinary.endConversation, false);
  await assert.rejects(ai.scamDecision(match, '#mock-fail'), e => e.code === 'SCAM_AI_UNAVAILABLE'); assert.equal(calls, before);
  const prod = loader({ 'utils/logger.ts': { logger: { info() {}, warn() {} } }, 'config/env.ts': { env, isProd: true }, 'integrations/index.ts': { getChat: () => { throw Error('never'); } } })('services/scamGame/ai.ts');
  await assert.rejects(prod.scamDecision(match, 'hi'), e => e.code === 'SCAM_AI_UNAVAILABLE');

  let pipeline, opts, filter, replacement;
  const repo = loader({ 'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1, ScamGamePlayer: {
    aggregate: p => { pipeline = p; return { option: o => { opts = o; return { exec: async () => [] }; } }; },
    replaceOne: (f, r) => { filter = f; replacement = r; return { exec: async () => ({ modifiedCount: 1 }) }; },
  } }, 'models/User.ts': { User: { collection: { name: 'users' } } } })('repositories/scamGame.repository.ts').scamGameRepository;
  await repo.cas({ _id: id(1), revision: 7 }, { revision: 100 }); assert.equal(filter.revision, 7); assert.equal(replacement.revision, 8);
  await repo.leaderboard([String(id(2))], 20, { score: 300, wins: 2, id: String(id(3)) });
  assert.equal(String(pipeline[0].$match._id.$nin[0]), String(id(2))); assert.equal(pipeline[0].$match.completed.$gt, 0);
  assert.equal(pipeline[1].$lookup.pipeline[0].$match.friendsJoinedAt.$ne, null);
  assert(pipeline[2].$match['member.0'].$exists);
  const windows = pipeline.filter(p => p.$setWindowFields); assert.equal(windows.length, 2);
  assert.equal(windows[0].$setWindowFields.sortBy.bestScore, -1); assert.equal(windows[0].$setWindowFields.sortBy.wins, -1);
  assert.equal(windows[1].$setWindowFields.partitionBy.score, '$bestScore'); assert.equal(windows[1].$setWindowFields.output.rank.$min, '$position');
  assert.equal(pipeline[6].$match.$or[2].wins, 2); assert.equal(pipeline[8].$limit, 21); assert.equal(opts.maxTimeMS, 3000);
  assert.deepEqual(Object.keys(pipeline.at(-1).$project).sort(), ['_id', 'bestScore', 'rank', 'wins']);

  let received;
  const rows = [{ _id: id(1), bestScore: 600, wins: 3, rank: 1 }, { _id: id(2), bestScore: 300, wins: 0, rank: 2 }];
  const service = loader({
    'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1 },
    'repositories/scamGame.repository.ts': { scamGameRepository: { leaderboard: async (...args) => { received = args; return rows; } } },
    'repositories/friendSafety.repository.ts': { friendBlockRepository: { blockedIdsFor: async () => new Set([String(id(9))]) } },
    'services/profile.service.ts': { profileService: { load: async () => new Map([[String(id(1)), { id: String(id(1)), displayName: 'Người chơi', avatarUrl: null }]]) }, profileOf: (map, key) => map.get(String(key)) },
    'config/env.ts': { env: {} }, 'services/scamGame/ai.ts': { isScamMock: () => true },
  })('services/scamGame.service.ts').scamGameService;
  const page = await service.leaderboard(id(1), 1); assert.equal(page.items.length, 1); assert(page.nextCursor); assert.equal(received[0][0], String(id(9)));
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['bestScore', 'player', 'rank', 'wins']);
  await service.leaderboard(id(1), 1, page.nextCursor); assert.equal(received[2].score, 600); assert.equal(received[2].wins, 3);
  await assert.rejects(service.leaderboard(id(2), 1, page.nextCursor), e => e.status === 400);
  await assert.rejects(service.leaderboard(id(1), 1, page.nextCursor + '='), e => e.status === 400);
  console.log('PASS scam AI/board: strict JSON, secret-redacted 24-bubble context, concurrency4, mock isolation, rank/filter/seek pipeline and scoped cursors (no Mongo/provider)');
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
