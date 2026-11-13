import type { Types } from 'mongoose';
import { Proposal, type ProposalDoc, type ProposalKind, type ProposalStatus } from '../models/Proposal.js';

/** All reads/writes are scoped by coupleId (Requirement 3.4). */
export const proposalRepository = {
  create(input: {
    coupleId: Types.ObjectId;
    kind: ProposalKind;
    payload: Record<string, unknown>;
    createdBy: Types.ObjectId;
  }): Promise<ProposalDoc> {
    return Proposal.create({ ...input, approvals: [input.createdBy] });
  },

  findById(coupleId: Types.ObjectId, id: string): Promise<ProposalDoc | null> {
    return Proposal.findOne({ _id: id, coupleId }).exec();
  },

  list(coupleId: Types.ObjectId, status?: ProposalStatus): Promise<ProposalDoc[]> {
    const filter: Record<string, unknown> = { coupleId };
    if (status) filter.status = status;
    return Proposal.find(filter).sort({ createdAt: -1 }).limit(50).exec();
  },

  findPendingByKind(coupleId: Types.ObjectId, kind: ProposalKind): Promise<ProposalDoc | null> {
    return Proposal.findOne({ coupleId, kind, status: 'pending' }).exec();
  },

  /** Atomically add an approval; returns the updated doc (or null if not pending). */
  addApproval(coupleId: Types.ObjectId, id: Types.ObjectId, userId: Types.ObjectId): Promise<ProposalDoc | null> {
    return Proposal.findOneAndUpdate(
      { _id: id, coupleId, status: 'pending' },
      { $addToSet: { approvals: userId } },
      { new: true },
    ).exec();
  },

  /** Transition pending → status atomically; returns null if it was no longer pending. */
  resolve(coupleId: Types.ObjectId, id: Types.ObjectId, status: Exclude<ProposalStatus, 'pending'>): Promise<ProposalDoc | null> {
    return Proposal.findOneAndUpdate(
      { _id: id, coupleId, status: 'pending' },
      { $set: { status, resolvedAt: new Date() } },
      { new: true },
    ).exec();
  },
};
