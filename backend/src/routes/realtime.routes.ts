import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { userRepository } from '../repositories/user.repository.js';
import { realtimeService, type RealtimeSpace } from '../services/realtime.service.js';
import { AppError, Errors } from '../utils/errors.js';

export const realtimeRouter = Router();
realtimeRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const space = req.query.space;
    if (space !== 'couple' && space !== 'friends') throw new AppError(400, 'INVALID_SPACE', 'Invalid realtime space');
    const user = await userRepository.findById(req.userId!);
    // The peer may have disconnected while the membership lookup was pending.
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');
    if (space === 'friends' && !user.friendsJoinedAt) throw new AppError(403, 'FRIENDS_NOT_JOINED', 'Bạn chưa tham gia Hội bạn bè');
    // Auth may expire while the membership read is in flight.
    if (req.accessExpiresAtMs! <= Date.now()) throw Errors.unauthorized('Invalid or expired access token');
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    if (!realtimeService.subscribe(req.userId!, space as RealtimeSpace, res, req.accessExpiresAtMs!)) {
      res.removeHeader('Content-Type');
      res.set('Retry-After', '10');
      throw new AppError(429, 'REALTIME_LIMIT', 'Realtime connection limit reached');
    }
  } catch (err) {
    if (!req.aborted && !res.destroyed && !res.writableEnded) next(err);
  }
});
