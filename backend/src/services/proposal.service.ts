import { Types } from 'mongoose';
import type { ZodTypeAny } from 'zod';
import type { CoupleDoc } from '../models/Couple.js';
import type { ProposalDoc, ProposalKind, ProposalStatus } from '../models/Proposal.js';
import { proposalRepository } from '../repositories/proposal.repository.js';
import { AppError, Errors } from '../utils/errors.js';
import { withSavingsWrite, type SavingsWriteContext } from './savingsWrite.service.js';
import { prepareSavingsProposal, savingsEffectExists } from './savings.service.js';
import { logger } from '../utils/logger.js';
import { notificationService } from './notification.service.js';

/**
 * A handler describes one kind of dual-approval decision:
 *  - `schema` validates the payload when the proposal is created
 *  - `apply` runs once when both members have approved
 *  - `summary` (optional) names the change for the partner's push, e.g. "mục tiêu nước 2.000 ml mỗi ngày"
 * Adding a new "needs both to agree" setting = register a new handler. No core changes.
 */
export interface ProposalHandler {
  kind: ProposalKind;
  schema: ZodTypeAny;
  apply(couple: CoupleDoc, payload: Record<string, unknown>, context: {
    proposalId: Types.ObjectId; createdBy: Types.ObjectId; savingsWrite?: SavingsWriteContext;
  }): Promise<void>;
  summary?(payload: Record<string, unknown>): string;
}

const handlers = new Map<ProposalKind, ProposalHandler>();

export function registerProposalHandler(handler: ProposalHandler): void {
  handlers.set(handler.kind, handler);
}

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  createdBy: string;
  approvals: string[];
  status: ProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** Savings only: effect remains retryable until durable application is confirmed. */
  applicationState?: 'awaiting_approval' | 'retryable' | 'applied';
}

function toView(p: ProposalDoc): ProposalView {
  return {
    id: p._id.toString(),
    kind: p.kind,
    payload: p.payload,
    createdBy: p.createdBy.toString(),
    approvals: p.approvals.map((a) => a.toString()),
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    resolvedAt: p.resolvedAt ? p.resolvedAt.toISOString() : null,
    ...(isSavings(p.kind) ? { applicationState: p.status === 'approved' ? 'applied' as const :
      p.status === 'pending' && p.approvals.length >= 2 ? 'retryable' as const : 'awaiting_approval' as const } : {}),
  };
}

function hasAllApprovals(couple: CoupleDoc, approvals: Types.ObjectId[]): boolean {
  const set = new Set(approvals.map((a) => a.toString()));
  return couple.memberIds.every((m) => set.has(m.toString()));
}

const isSavings = (kind: ProposalKind) => kind === 'savings_goal' || kind === 'savings_goal_update';

async function createSavings(couple: CoupleDoc, userId: string, kind: ProposalKind, payload: Record<string, unknown>, handler: ProposalHandler): Promise<ProposalView> {
  return withSavingsWrite(couple, userId, async (ctx) => {
    const prepared = await prepareSavingsProposal(ctx.couple, kind, payload);
    if (await proposalRepository.findPendingByKind(ctx.couple._id, kind)) throw Errors.conflict('Đã có một đề xuất cùng loại đang chờ duyệt');
    let doc: ProposalDoc;
    try {
      doc = await proposalRepository.create({ coupleId: ctx.couple._id, kind, payload: prepared, createdBy: new Types.ObjectId(userId) });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 11000) throw Errors.conflict('Đã có một đề xuất cùng loại đang chờ duyệt');
      throw err;
    }
    ctx.afterRelease.push(() => notificationService.toPartner(ctx.couple, userId, {
      type: 'proposal_created', entityId: doc._id,
      push: { body: (name) => `${name} đề xuất ${handler.summary?.(prepared) ?? 'thay đổi quỹ chung'}. Chờ bạn duyệt`, url: '/approvals', tag: `proposal:${doc.id}` },
    }));
    return toView(doc);
  });
}

async function resolveSavings(couple: CoupleDoc, userId: string, id: string, reject: boolean): Promise<ProposalView> {
  return withSavingsWrite(couple, userId, async (ctx) => {
    const current = await proposalRepository.findById(ctx.couple._id, id);
    if (!current || !isSavings(current.kind)) throw Errors.notFound('Đề xuất không tồn tại');
    if (current.status === 'approved') return toView(current); // acknowledged retry, effect already confirmed
    if (current.status !== 'pending') throw Errors.conflict('Đề xuất đã được xử lý');
    const effect = await savingsEffectExists(ctx.couple, current);
    // A crash after applying must never allow reject to orphan the effect.
    if (reject && !effect) {
      const rejected = await proposalRepository.resolve(ctx.couple._id, current._id, 'rejected');
      if (!rejected) throw Errors.conflict('Đề xuất đã được xử lý');
      return toView(rejected);
    }
    const updated = effect ? current : await proposalRepository.addApproval(ctx.couple._id, current._id, new Types.ObjectId(userId));
    if (!updated) throw Errors.conflict('Đề xuất đã được xử lý');
    if (!effect && !hasAllApprovals(ctx.couple, updated.approvals)) return toView(updated);
    const handler = handlers.get(updated.kind);
    if (!handler) throw new AppError(503, 'SAVINGS_APPLY_UNAVAILABLE', 'Chưa thể áp dụng đề xuất quỹ');
    // Pending is retained across every failure boundary. Handler's durable marker makes retry idempotent.
    await handler.apply(ctx.couple, updated.payload, { proposalId: updated._id, createdBy: updated.createdBy, savingsWrite: ctx });
    const resolved = await proposalRepository.resolve(ctx.couple._id, updated._id, 'approved');
    if (!resolved) throw new Error('Savings proposal resolve outcome requires reconciliation');
    return toView(resolved);
  });
}

export const proposalService = {
  async create(
    couple: CoupleDoc,
    userId: string,
    kind: ProposalKind,
    rawPayload: unknown,
  ): Promise<ProposalView> {
    const handler = handlers.get(kind);
    if (!handler) throw Errors.badRequest(`Loại đề xuất không hỗ trợ: ${kind}`);
    const payload = handler.schema.parse(rawPayload) as Record<string, unknown>;
    if (isSavings(kind)) return createSavings(couple, userId, kind, payload, handler);

    const existing = await proposalRepository.findPendingByKind(couple._id, kind);
    if (existing) throw Errors.conflict('Đã có một đề xuất cùng loại đang chờ duyệt');

    const doc = await proposalRepository.create({
      coupleId: couple._id,
      kind,
      payload,
      createdBy: new Types.ObjectId(userId),
    });
    logger.info('Proposal created', { coupleId: couple._id.toString(), userId, kind, proposalId: doc._id.toString() });
    let what: string | null = null;
    try {
      what = handler.summary?.(payload) ?? null;
    } catch {
      what = null;
    }
    await notificationService.toPartner(couple, userId, {
      type: 'proposal_created',
      entityId: doc._id,
      push: {
        body: (name) => (what ? `${name} đề xuất đổi ${what}. Chờ bạn duyệt` : `${name} vừa gửi một đề xuất, chờ bạn duyệt`),
        url: '/approvals',
        tag: `proposal:${doc._id.toString()}`,
      },
    });
    return toView(doc);
  },

  async list(coupleId: Types.ObjectId, status?: ProposalStatus): Promise<ProposalView[]> {
    const docs = await proposalRepository.list(coupleId, status);
    return docs.map(toView);
  },

  async approve(couple: CoupleDoc, userId: string, id: string): Promise<ProposalView> {
    const current = await proposalRepository.findById(couple._id, id);
    if (!current) throw Errors.notFound('Đề xuất không tồn tại');
    if (isSavings(current.kind)) return resolveSavings(couple, userId, id, false);
    if (current.status !== 'pending') throw Errors.conflict('Đề xuất đã được xử lý');

    const updated = await proposalRepository.addApproval(couple._id, current._id, new Types.ObjectId(userId));
    if (!updated) throw Errors.conflict('Đề xuất đã được xử lý');

    if (!hasAllApprovals(couple, updated.approvals)) {
      logger.info('Proposal approved by one member', { coupleId: couple._id.toString(), userId, proposalId: id });
      return toView(updated);
    }

    // Both approved: resolve atomically so apply() runs exactly once.
    const resolved = await proposalRepository.resolve(couple._id, current._id, 'approved');
    if (!resolved) throw Errors.conflict('Đề xuất đã được xử lý');

    const handler = handlers.get(resolved.kind);
    if (handler) {
      await handler.apply(couple, resolved.payload, { proposalId: resolved._id, createdBy: resolved.createdBy });
    }
    logger.info('Proposal fully approved and applied', {
      coupleId: couple._id.toString(),
      userId,
      kind: resolved.kind,
      proposalId: id,
    });
    return toView(resolved);
  },

  async reject(couple: CoupleDoc, userId: string, id: string): Promise<ProposalView> {
    const current = await proposalRepository.findById(couple._id, id);
    if (!current) throw Errors.notFound('Đề xuất không tồn tại');
    if (isSavings(current.kind)) return resolveSavings(couple, userId, id, true);
    const resolved = await proposalRepository.resolve(couple._id, current._id, 'rejected');
    if (!resolved) throw Errors.conflict('Đề xuất đã được xử lý');
    logger.info('Proposal rejected', { coupleId: couple._id.toString(), userId, proposalId: id });
    return toView(resolved);
  },
};
