import { z } from 'zod';
import type { Request, Response } from 'express';
import { pairingService } from '../services/pairing.service.js';
import { ok } from '../utils/response.js';

export const inviteSchema = z.object({
  toEmail: z.string().email('Email không hợp lệ').max(254),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'ID không hợp lệ'),
});

export const pairingController = {
  async invite(req: Request, res: Response): Promise<void> {
    const view = await pairingService.invite(req.userId!, req.body.toEmail);
    ok(res, view, 201);
  },

  async list(req: Request, res: Response): Promise<void> {
    ok(res, await pairingService.listInvites(req.userId!));
  },

  async accept(req: Request, res: Response): Promise<void> {
    ok(res, await pairingService.accept(req.userId!, req.params.id));
  },

  async reject(req: Request, res: Response): Promise<void> {
    await pairingService.reject(req.userId!, req.params.id);
    ok(res, { ok: true });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    await pairingService.cancel(req.userId!, req.params.id);
    ok(res, { ok: true });
  },
};
