import type { NextFunction, Request, Response } from 'express';
import { userRepository } from '../repositories/user.repository.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { AppError, Errors } from '../utils/errors.js';

/**
 * Attach req.coupleId + req.couple for the authenticated user. Must run after requireAuth.
 * Rejects with 403 NO_COUPLE when the user is not paired, so the frontend can
 * redirect to the pairing flow (Requirement 2.6).
 *
 * Every repository call for business data MUST receive req.coupleId — this
 * middleware is the single source of that id (Requirement 3).
 */
export async function requireCouple(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Routers mounted on the shared '/api' prefix each apply requireCouple, so one request can pass
  // through it several times. Resolve the couple once and reuse it.
  if (req.couple) {
    next();
    return;
  }
  try {
    const user = await userRepository.findById(req.userId!);
    if (!user) throw Errors.unauthorized();
    if (!user.coupleId) {
      throw new AppError(403, 'NO_COUPLE', 'Bạn chưa ghép đôi');
    }
    const couple = await coupleRepository.findActiveById(user.coupleId);
    if (!couple) {
      throw new AppError(403, 'NO_COUPLE', 'Couple không còn hoạt động');
    }
    req.coupleId = couple._id;
    req.couple = couple;
    next();
  } catch (err) {
    next(err);
  }
}
