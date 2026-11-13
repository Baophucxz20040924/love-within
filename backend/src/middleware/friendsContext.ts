import type { NextFunction, Request, Response } from 'express';
import { userRepository } from '../repositories/user.repository.js';
import { AppError, Errors } from '../utils/errors.js';

/**
 * Hidden friends space: attach req.friendsMember for the authenticated user. Must run after requireAuth.
 * 403 FRIENDS_NOT_JOINED until the user has entered the space once (POST /api/friends/join, called by
 * the hidden login page), so accounts that only use the couple app never show up there.
 * No couple is needed.
 */
export async function requireFriendsMember(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.friendsMember) {
    next();
    return;
  }
  try {
    const user = await userRepository.findById(req.userId!);
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');
    if (!user.friendsJoinedAt) throw new AppError(403, 'FRIENDS_NOT_JOINED', 'Bạn chưa tham gia Hội bạn bè');
    req.friendsMember = user;
    next();
  } catch (err) {
    next(err);
  }
}
