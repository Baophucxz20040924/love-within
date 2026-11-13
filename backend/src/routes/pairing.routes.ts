import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { inviteLimiter } from '../middleware/rateLimit.js';
import { idParamSchema, inviteSchema, pairingController } from '../controllers/pairing.controller.js';

export const pairingRouter = Router();

pairingRouter.use(requireAuth);

pairingRouter.post('/invite', inviteLimiter, validate({ body: inviteSchema }), asyncHandler(pairingController.invite));
pairingRouter.get('/invites', asyncHandler(pairingController.list));
pairingRouter.post(
  '/invites/:id/accept',
  validate({ params: idParamSchema }),
  asyncHandler(pairingController.accept),
);
pairingRouter.post(
  '/invites/:id/reject',
  validate({ params: idParamSchema }),
  asyncHandler(pairingController.reject),
);
pairingRouter.post(
  '/invites/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(pairingController.cancel),
);
