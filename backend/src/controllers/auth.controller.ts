import { z } from 'zod';
import type { Request, Response } from 'express';
import { authService } from '../services/auth.service.js';
import { ok } from '../utils/response.js';

export const newPasswordSchema = z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự').max(72, 'Mật khẩu quá dài')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72 && !value.includes('\0'), 'Mật khẩu tối đa 72 byte và không chứa ký tự rỗng');
export const registerSchema = z.object({
  email: z.string().trim().email('Email không hợp lệ').max(254),
  password: newPasswordSchema,
  displayName: z.string().trim().min(1, 'Tên hiển thị bắt buộc').max(60),
});
export const loginSchema = z.object({
  email: z.string().trim().email('Email không hợp lệ').max(254),
  // Allow legacy >72-byte passwords to log in; new passwords are never silently truncated.
  password: z.string().min(1, 'Mật khẩu bắt buộc').max(1024),
});
export const refreshSchema = z.object({ refreshToken: z.string().min(1, 'Thiếu refresh token').max(4096) });
export const passwordChangeSchema = z.object({
  passwordChangeToken: z.string().min(1).max(4096), newPassword: newPasswordSchema, confirmPassword: z.string().max(72),
}).refine((value) => value.newPassword === value.confirmPassword, { message: 'Mật khẩu xác nhận không khớp', path: ['confirmPassword'] });

export const authController = {
  async register(req: Request, res: Response): Promise<void> { ok(res, await authService.register(req.body), 201); },
  async login(req: Request, res: Response): Promise<void> { ok(res, await authService.login(req.body)); },
  async refresh(req: Request, res: Response): Promise<void> { ok(res, await authService.refresh(req.body.refreshToken)); },
  async completePasswordChange(req: Request, res: Response): Promise<void> { ok(res, await authService.completePasswordChange(req.body)); },
};
