import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { loginLimiter, loginTotalLimiter, passwordChangeLimiter, refreshLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { apiNoStore } from '../middleware/security.js';
import {
  authController,
  loginSchema,
  passwordChangeSchema,
  refreshSchema,
  registerSchema,
} from '../controllers/auth.controller.js';

export const authRouter = Router();
authRouter.use(apiNoStore);
authRouter.post('/password-change', passwordChangeLimiter, validate({ body: passwordChangeSchema }), asyncHandler(authController.completePasswordChange));

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
