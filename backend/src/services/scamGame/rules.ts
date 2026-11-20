import { randomInt, randomUUID } from 'node:crypto';
import { answerPattern, currentStep, generateScenario, publicScenario, scenarioFor, type ScenarioId } from './scenarios.js';
import type { ScamMatch, ScamMemory, ScamPlayer, ScamRuntimeContext, ScamStage } from '../../models/ScamGamePlayer.js';
import { SCAM_CHARACTERS } from './characters.js';
import { emotionFor, isScamEmotion, type ScamEmotion } from './emotions.js';

export const STAGES: readonly ScamStage[] = ['account', 'password', 'otp'];
export const STAGE_POINTS = { account: 100, password: 200, otp: 300 };
export const SCAM_BALANCE = {
  initialTrust: 30,
  gates: { account: 35, password: 50, otp: 65 },
  trustDelta: { min: -12, max: 20 },
} as const;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export interface ScamDecision { reply: string; emotion: ScamEmotion; trustDelta: number; offerCurrentSecret: boolean; endConversation: boolean; contextUpdate: ScamMemory }
export const nextTrust = (match: ScamMatch, delta: number) => clamp(match.trust + clamp(delta, SCAM_BALANCE.trustDelta.min, SCAM_BALANCE.trustDelta.max), 0, 100);

export function newMatch(previous?: string, selectedScenario?: ScenarioId): ScamMatch {
  const choices = SCAM_CHARACTERS.filter(c => c.id !== previous);
  const profile = structuredClone(choices[randomInt(choices.length)]);
  const { id, name, emoji, description, persona, scene, opening } = profile;
  const generated = generateScenario(`${persona}\n${scene}\n${opening}`, selectedScenario);
  return { id: randomUUID(), character: { id, name, emoji, description }, status: 'active', score: 0,
    trust: SCAM_BALANCE.initialTrust, emotion: 'neutral', turns: 0, ...generated,
    runtimeContext: { version: 1, profile: { id, name, persona }, scene, memory: { summary: '', facts: [], openThreads: [] } },
    revealed: [], messages: [{ id: randomUUID(), role: 'assistant', text: opening }], startedAt: new Date().toISOString(), endedAt: null };
}

/** Redact the published comparison variants; only the current canonical value enters the trusted block. */
export function redactSecrets(text: string, match: ScamMatch): string {
  text = text.normalize('NFC');
  for (const step of scenarioFor(match).steps) text = text.replace(answerPattern(match.secrets[step.id], step.policy), '[thông tin đã ẩn]');
  return text;
}

export function cleanMemory(memory: ScamMemory, match: ScamMatch): ScamMemory {
  const list = (items: string[], max: number) => [...new Set(items.map(s => redactSecrets(s, match).trim().slice(0, 160)).filter(Boolean))].slice(0, max);
  return { summary: redactSecrets(memory.summary, match).slice(0, 1000), facts: list(memory.facts, 8), openThreads: list(memory.openThreads, 4) };
}

/** Pure compatibility view: never change the scene of an already-started legacy conversation. */
export function contextFor(match: ScamMatch): ScamRuntimeContext {
  return match.runtimeContext ?? { version: 1,
    profile: { id: match.character.id, name: match.character.name, persona: match.character.persona ?? match.character.description },
    scene: 'Tiếp tục bối cảnh cuộc trò chuyện đã bắt đầu trong lịch sử; không đổi địa điểm hoặc bắt đầu lại cuộc gọi.',
    memory: { summary: redactSecrets(match.memory ?? '', match).slice(0, 1000), facts: [], openThreads: [] } };
}

export function ensureContext(match: ScamMatch): void {
  if (match.status !== 'active') return;
  match.runtimeContext ??= structuredClone(contextFor(match));
  delete match.memory;
  delete match.character.persona;
  delete match.character.opening;
}

export function clearContext(match: ScamMatch): void {
  delete match.runtimeContext;
  delete match.memory;
  delete match.character.persona;
  delete match.character.opening;
}

/** Validate disclosure before mutating anything. Hang-up always suppresses disclosure. */
export function validateDisclosure(match: ScamMatch, decision: ScamDecision): void {
  if (decision.endConversation) return;
  const eligible = nextTrust(match, decision.trustDelta) >= currentStep(match).gate;
  const current = match.secrets[match.stage];
  if (decision.offerCurrentSecret && (!eligible || !decision.reply.includes(current))) throw new Error('invalid disclosure');
  for (const step of scenarioFor(match).steps) {
    if (answerPattern(match.secrets[step.id], step.policy).test(decision.reply.normalize('NFC')) && (step.id !== match.stage || !decision.offerCurrentSecret || !eligible)) throw new Error('unexpected disclosure');
  }
}

export function append(match: ScamMatch, role: 'user' | 'assistant' | 'system', text: string, operationId?: string): void {
  match.messages = [...match.messages, { id: randomUUID(), role, text, ...(role === 'user' && operationId ? { operationId } : {}) }].slice(-80);
}

export function applyDecision(match: ScamMatch, text: string, decision: ScamDecision, operationId?: string): void {
  if (!isScamEmotion(decision.emotion)) throw new Error('invalid emotion');
  validateDisclosure(match, decision);
  ensureContext(match);
  match.emotion = decision.emotion;
  match.trust = nextTrust(match, decision.trustDelta);
  append(match, 'user', text, operationId);
  append(match, 'assistant', decision.endConversation ? redactSecrets(decision.reply, match) : decision.reply);
  match.runtimeContext!.memory = cleanMemory(decision.contextUpdate, match);
  match.turns++;
  if (decision.endConversation) {
    match.status = 'lost';
    match.endedAt = new Date().toISOString();
    clearContext(match);
    append(match, 'system', 'Nhân vật đã ngắt liên lạc. Ván kết thúc.');
    return;
  }
  if (decision.offerCurrentSecret && !match.revealed.includes(match.stage)) match.revealed.push(match.stage);
}

export function finishStats(player: ScamPlayer): void {
  const match = player.match!;
  clearContext(match);
  player.bestScore = Math.max(player.bestScore, match.score);
  player.wins += match.status === 'won' ? 1 : 0;
  player.completed++;
}

/** Explicit allowlist: never serialize raw player/match/pending data. */
export function playerView(player: ScamPlayer, mock: boolean) {
  const m = player.match;
  return { revision: player.revision, bestScore: player.bestScore, wins: player.wins, mock,
    pending: player.pending ? { operationId: player.pending.operationId, expectedRevision: player.pending.expectedRevision, expiresAt: player.pending.expiresAt, text: player.pending.text } : null,
    recentOperations: player.receipts.map(r => r.operationId),
    match: m ? { id: m.id, character: { id: m.character.id, name: m.character.name, emoji: m.character.emoji, description: m.character.description },
      status: m.status, stage: m.stage, scenario: publicScenario(m), score: m.score, trust: m.trust, emotion: emotionFor(m),
      turns: m.turns, revealed: m.revealed, messages: m.messages.map(({ id, role, text, operationId }) => ({ id, role, text, ...(role === 'user' && operationId ? { operationId } : {}) })), startedAt: m.startedAt, endedAt: m.endedAt } : null };
}
