import { z } from 'zod';
import type { Request, Response } from 'express';
import { adminService } from '../services/admin.service.js';
import { newPasswordSchema } from './auth.controller.js';
import { ok } from '../utils/response.js';

export const adminLookupSchema = z.object({ email: z.string().trim().email('Email không hợp lệ').max(254) });
export const adminTargetSchema = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Tài khoản không hợp lệ') });
export const adminResetSchema = z.object({
  expectedCredentialVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  currentAdminPassword: z.string().min(1).max(1024),
});
export const adminChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024), newPassword: newPasswordSchema, confirmPassword: z.string().max(72),
}).refine((value) => value.newPassword === value.confirmPassword, { message: 'Mật khẩu xác nhận không khớp', path: ['confirmPassword'] });
const actor = (req: Request) => ({ userId: req.userId!, credentialVersion: req.credentialVersion! });

export const adminController = {
  async login(req: Request, res: Response): Promise<void> { ok(res, await adminService.login(req.body)); },
  async findUser(req: Request, res: Response): Promise<void> { ok(res, await adminService.findUser(actor(req), req.query.email as string)); },
  async resetPassword(req: Request, res: Response): Promise<void> { ok(res, await adminService.resetPassword(actor(req), req.params.id, req.body)); },
  async changePassword(req: Request, res: Response): Promise<void> { ok(res, await adminService.changePassword(actor(req), req.body)); },
};
