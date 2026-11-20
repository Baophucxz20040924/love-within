import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { SCAM_RULE_VERSION, type ScamPlayer, type ScamStage } from '../models/ScamGamePlayer.js';
import { scamGameRepository, type ScamBoardPosition } from '../repositories/scamGame.repository.js';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { profileService, profileOf } from './profile.service.js';
import { AppError, Errors } from '../utils/errors.js';
import { env } from '../config/env.js';
import { applyDecision, append, ensureContext, finishStats, newMatch, playerView } from './scamGame/rules.js';
import { normalizeAnswer, scenarioFor } from './scamGame/scenarios.js';
import { isScamMock, scamDecision } from './scamGame/ai.js';
import { matchDeadline, matchExpired } from './scamGame/time.js';

export interface ScamOperation { operationId: string; expectedRevision: number; matchId?: string }
const fingerprint = (kind: string, op: ScamOperation, payload: unknown) => createHash('sha256').update(JSON.stringify([kind, op.expectedRevision, op.matchId ?? null, payload])).digest('hex');
const conflict = () => new AppError(409, 'SCAM_STATE_CHANGED', 'Ván đã thay đổi. Hãy đồng bộ lại trước khi tiếp tục.');
const busy = () => new AppError(409, 'SCAM_TURN_PENDING', 'Nhân vật đang trả lời. Hãy đợi hoặc đồng bộ lại.');
const view = (p: ScamPlayer) => playerView(p, isScamMock());
const copy = (p: ScamPlayer): ScamPlayer => ({ ...p, match: p.match ? structuredClone(p.match) : null, pending: p.pending ? { ...p.pending } : null, receipts: [...p.receipts] });
function replay(p: ScamPlayer, op: ScamOperation, hash: string): boolean {
  const receipt = p.receipts.find(r => r.operationId === op.operationId);
  if (!receipt) return false;
  if (receipt.fingerprint !== hash) throw Errors.conflict('Mã thao tác đã được sử dụng cho nội dung khác.');
  return true;
}
function check(p: ScamPlayer, op: ScamOperation, active = true): void {
  if (p.revision !== op.expectedRevision) throw conflict();
  if (active && (!p.match || p.match.id !== op.matchId || p.match.status !== 'active')) throw conflict();
  if (p.ruleVersion !== SCAM_RULE_VERSION) throw conflict();
}
function receipt(p: ScamPlayer, op: ScamOperation, hash: string): void {
  p.receipts = [...p.receipts, { operationId: op.operationId, fingerprint: hash }].slice(-16);
}
async function settled(userId: Types.ObjectId): Promise<ScamPlayer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await scamGameRepository.get(userId);
    if (!p.match || !matchExpired(p.match)) return p;
    const next = copy(p), match = next.match!;
    match.status = 'lost'; match.endReason = 'timeout';
    match.endedAt = new Date(matchDeadline(match)).toISOString();
    next.pending = null;
    append(match, 'system', 'Hết 15 phút. Cuộc trò chuyện đã kết thúc. Tiền đã đạt được giữ lại.');
    finishStats(next);
    if (await scamGameRepository.cas(p, next)) { next.revision = p.revision + 1; return next; }
  }
  throw conflict();
}
async function commit(old: ScamPlayer, next: ScamPlayer) {
  const deadline = old.match?.status === 'active' ? matchDeadline(old.match) : undefined;
  if (!(await scamGameRepository.cas(old, next, deadline))) {
    await settled(old._id);
    throw conflict();
  }
  next.revision = old.revision + 1;
  return view(next);
}

export const scamGameService = {
  async state(userId: Types.ObjectId) { return view(await settled(userId)); },
  async start(userId: Types.ObjectId, op: ScamOperation) {
    const p = await settled(userId), hash = fingerprint('start', op, null);
    if (replay(p, op, hash)) return view(p);
    check(p, op, false);
    if (p.match?.status === 'active' || p.pending) throw conflict();
    const next = copy(p);
    next.match = newMatch(p.match?.character.id);
    receipt(next, op, hash);
    return commit(p, next);
  },
  async message(userId: Types.ObjectId, op: ScamOperation, text: string) {
    const p = await settled(userId), hash = fingerprint('message', op, text);
    if (replay(p, op, hash)) return view(p);
    if (p.pending) {
      if (p.pending.operationId !== op.operationId) throw busy();
      if (p.pending.fingerprint !== hash) throw Errors.conflict('Mã thao tác đã được dùng cho nội dung khác.');
      if (p.pending.expiresAt > Date.now()) throw busy();
      if (!p.match || p.match.id !== op.matchId || p.match.status !== 'active') throw conflict();
    } else check(p, op);
    const reserved = copy(p);
    ensureContext(reserved.match!);
    // Adapter may retry once; lease outlasts both bounded calls. A stale result is always CAS-fenced.
    reserved.pending = { operationId: op.operationId, fingerprint: hash, token: randomUUID(), expectedRevision: op.expectedRevision,
      expiresAt: Date.now() + Math.max(120_000, env.beeknoee.chatTimeoutMs * 2 + 30_000), text };
    if (!(await scamGameRepository.cas(p, reserved, matchDeadline(p.match!)))) {
      await settled(userId);
      throw conflict();
    }
    reserved.revision = p.revision + 1;
    try {
      if (matchExpired(reserved.match!)) { await settled(userId); throw conflict(); }
      const decision = await scamDecision(reserved.match!, text);
      if (matchExpired(reserved.match!)) { await settled(userId); throw conflict(); }
      const next = copy(reserved);
      applyDecision(next.match!, text, decision, op.operationId);
      if (next.match!.status !== 'active') finishStats(next);
      next.pending = null;
      receipt(next, op, hash);
      return await commit(reserved, next);
    } catch (error) {
      // Stop/replay may have replaced this reservation: never clear someone else's token or state.
      if (error instanceof AppError && error.code === 'SCAM_STATE_CHANGED') throw error;
      if (matchExpired(reserved.match!)) { await settled(userId); throw conflict(); }
      const released = copy(reserved); released.pending = null;
      if (!(await scamGameRepository.cas(reserved, released, matchDeadline(reserved.match!)))) await settled(userId);
      throw error;
    }
  },
  async verify(userId: Types.ObjectId, op: ScamOperation, stage: ScamStage, value: string) {
    const p = await settled(userId), hash = fingerprint('verify', op, [stage, value]);
    if (replay(p, op, hash)) return view(p);
    check(p, op);
    if (p.pending) throw busy();
    const m = p.match!;
    if (m.stage !== stage) throw Errors.conflict('Hãy xác nhận mục hiện tại trước.');
    const scenario = scenarioFor(m), index = scenario.steps.findIndex(step => step.id === stage), step = scenario.steps[index];
    const normalized = normalizeAnswer(value, step.policy);
    if (normalized === null || normalized !== normalizeAnswer(m.secrets[stage], step.policy)) throw new AppError(422, 'SCAM_INCORRECT', 'Thông tin chưa chính xác. Kiểm tra lại tin nhắn nhé.');
    const next = copy(p), match = next.match!;
    ensureContext(match);
    match.score += step.points;
    append(match, 'system', `Đã xác nhận ${step.label}. +${step.points}$.`);
    if (index === scenario.steps.length - 1) {
      match.status = 'won'; match.endedAt = new Date().toISOString();
      match.bonus = randomInt(30, 151);
      match.score += match.bonus;
      append(match, 'system', `Thưởng may mắn: +${match.bonus}$. $ là tiền giả lập.`);
      finishStats(next);
    }
    else match.stage = scenario.steps[index + 1].id;
    receipt(next, op, hash);
    return commit(p, next);
  },
  async stop(userId: Types.ObjectId, op: ScamOperation) {
    const p = await settled(userId), hash = fingerprint('stop', op, null);
    if (replay(p, op, hash)) return view(p);
    check(p, op);
    const next = copy(p);
    next.pending = null;
    next.match!.status = 'stopped'; next.match!.endedAt = new Date().toISOString();
    append(next.match!, 'system', 'Bạn đã dừng scam. Tiền giả lập đã đạt được giữ lại.');
    finishStats(next); receipt(next, op, hash);
    return commit(p, next);
  },
  async leaderboard(userId: Types.ObjectId, limit: number, cursor?: string) {
    const scope = `scam:friends-v2:${SCAM_RULE_VERSION}:${userId}`;
    let after: ScamBoardPosition | undefined;
    if (cursor) {
      try {
        const a = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(a) || a.length !== 5 || a[0] !== scope || !Number.isSafeInteger(a[1]) || a[1] < 0 || a[1] > 750
          || !Number.isSafeInteger(a[2]) || a[2] < 0 || !/^[a-f\d]{24}$/.test(a[3]) || a[4] !== 1
          || Buffer.from(JSON.stringify(a)).toString('base64url') !== cursor) throw new Error('cursor');
        after = { score: a[1], wins: a[2], id: a[3] };
      } catch { throw Errors.badRequest('Cursor không hợp lệ.'); }
    }
    const blocked = await friendBlockRepository.blockedIdsFor(userId);
    const rows = await scamGameRepository.leaderboard(userId, [...blocked], limit, after);
    const page = rows.slice(0, limit), last = page[page.length - 1];
    const profiles = await profileService.load(page.map(r => r._id), { skipMissing: true });
    return { items: page.filter(r => profiles.has(String(r._id))).map(r => ({ player: profileOf(profiles, r._id), bestScore: r.bestScore, wins: r.wins, rank: r.rank })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([scope, last.bestScore, last.wins, String(last._id), 1])).toString('base64url') : null };
  },
};
