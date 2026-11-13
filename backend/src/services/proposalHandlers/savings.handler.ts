import type { ProposalHandler } from '../proposal.service.js';
import { applySavingsProposal } from '../savings.service.js';
import { savingsCreateSchema, savingsUpdatePayloadSchema } from '../savings.validation.js';

export const savingsGoalHandler: ProposalHandler = {
  kind: 'savings_goal', schema: savingsCreateSchema,
  async apply(_couple, payload, context) {
    if (!context.savingsWrite) throw new Error('Savings effect requires the couple write token');
    await applySavingsProposal(context.savingsWrite, payload, context.proposalId, context.createdBy, 'savings_goal');
  },
  summary: (p) => `tạo quỹ “${p.title}”`,
};
export const savingsGoalUpdateHandler: ProposalHandler = {
  kind: 'savings_goal_update', schema: savingsUpdatePayloadSchema,
  async apply(_couple, payload, context) {
    if (!context.savingsWrite) throw new Error('Savings effect requires the couple write token');
    await applySavingsProposal(context.savingsWrite, payload, context.proposalId, context.createdBy, 'savings_goal_update');
  },
  summary: (p) => `${p.close ? 'đóng' : 'cập nhật'} quỹ “${p.title}”`,
};
