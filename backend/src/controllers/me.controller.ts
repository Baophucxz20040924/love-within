import type { Request, Response } from 'express';
import { userRepository } from '../repositories/user.repository.js';
import { coupleRepository } from '../repositories/couple.repository.js';
import { buildCoupleView } from '../services/couple.service.js';
import { walletService } from '../services/wallet.service.js';
import { avatarUrlOf } from '../services/profile.service.js';
import { ok } from '../utils/response.js';
import { Errors } from '../utils/errors.js';

export const meController = {
  async get(req: Request, res: Response): Promise<void> {
    const user = await userRepository.findById(req.userId!);
    if (!user) throw Errors.unauthorized('Tài khoản không tồn tại');

    const coupleDoc = user.coupleId ? await coupleRepository.findActiveById(user.coupleId) : null;
    const [couple, wallet] = coupleDoc
      ? await Promise.all([buildCoupleView(coupleDoc), walletService.getView(coupleDoc._id)])
      : [null, null];

    ok(res, {
      user: {
        id: user._id.toString(),
        email: user.email,
        displayName: user.displayName,
        avatarUrl: await avatarUrlOf(user.avatarKey),
        coupleId: coupleDoc ? coupleDoc._id.toString() : null,
        timezone: user.timezone,
      },
      couple,
      wallet,
      level: wallet?.level ?? 1,
      exp: wallet?.exp ?? 0,
    });
  },
};
