import { z } from 'zod';
import type { Request, Response } from 'express';
import { proposalService } from '../services/proposal.service.js';
import { ok } from '../utils/response.js';
import type { ProposalStatus } from '../models/Proposal.js';

export const listProposalsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
});

export const proposalIdParam = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ'),
});

export const proposalController = {
  async list(req: Request, res: Response): Promise<void> {
    const status = req.query.status as ProposalStatus | undefined;
    ok(res, await proposalService.list(req.coupleId!, status));
  },

  async approve(req: Request, res: Response): Promise<void> {
    ok(res, await proposalService.approve(req.couple!, req.userId!, req.params.id));
  },

  async reject(req: Request, res: Response): Promise<void> {
    ok(res, await proposalService.reject(req.couple!, req.userId!, req.params.id));
  },
};
