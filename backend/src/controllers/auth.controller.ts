import { z } from 'zod';
import type { Request, Response } from 'express';
import { authService } from '../services/auth.service.js';
import { ok } from '../utils/response.js';

export const registerSchema = z.object({
  email: z.string().email('Email không hợp lệ').max(254),
  password: z
    .string()
    .min(8, 'Mật khẩu tối thiểu 8 ký tự')
    .max(128, 'Mật khẩu quá dài'),
  displayName: z.string().min(1, 'Tên hiển thị bắt buộc').max(60).trim(),
});

export const loginSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(1, 'Mật khẩu bắt buộc'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Thiếu refresh token'),
});

export const authController = {
  async register(req: Request, res: Response): Promise<void> {
    const tokens = await authService.register(req.body);
    ok(res, tokens, 201);
  },

  async login(req: Request, res: Response): Promise<void> {
    const tokens = await authService.login(req.body);
    ok(res, tokens);
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const tokens = await authService.refresh(req.body.refreshToken);
    ok(res, tokens);
  },
};
