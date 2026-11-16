import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { apiNoStore } from '../middleware/security.js';
import { adminCredentialLimiter, adminLookupLimiter, loginLimiter, loginTotalLimiter } from '../middleware/rateLimit.js';
import { loginSchema } from '../controllers/auth.controller.js';
import { adminController, adminLookupSchema, adminTargetSchema, adminResetSchema, adminChangeSchema } from '../controllers/admin.controller.js';

export const adminRouter = Router();
adminRouter.use(apiNoStore);
adminRouter.post('/login', loginTotalLimiter, loginLimiter, validate({ body: loginSchema }), asyncHandler(adminController.login));
adminRouter.use(requireAdmin);
adminRouter.get('/users', adminLookupLimiter, validate({ query: adminLookupSchema }), asyncHandler(adminController.findUser));
adminRouter.post('/users/:id/reset-password', adminCredentialLimiter,
  validate({ params: adminTargetSchema, body: adminResetSchema }), asyncHandler(adminController.resetPassword));
adminRouter.post('/change-password', adminCredentialLimiter, validate({ body: adminChangeSchema }), asyncHandler(adminController.changePassword));
