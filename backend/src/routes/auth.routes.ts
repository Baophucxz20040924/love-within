import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { loginLimiter, loginTotalLimiter, refreshLimiter, registerLimiter } from '../middleware/rateLimit.js';
import {
  authController,
  loginSchema,
  refreshSchema,
  registerSchema,
} from '../controllers/auth.controller.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  registerLimiter,
  validate({ body: registerSchema }),
  asyncHandler(authController.register),
);
authRouter.post('/login', loginTotalLimiter, loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));
authRouter.post(
  '/refresh',
  refreshLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(authController.refresh),
);
