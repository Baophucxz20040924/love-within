import { Types } from 'mongoose';
import { friendBlockRepository } from '../repositories/friendSafety.repository.js';
import { logger } from '../utils/logger.js';
import { configureFriendOutingNotifications, friendOutingService } from './friendOuting.service.js';
import { notificationService } from './notification.service.js';

/** Installed once at app startup; outing transactions never depend on push delivery. */
export function registerFriendOutingNotifications(): void {
  configureFriendOutingNotifications(async (event) => {
    const actorId = new Types.ObjectId(event.actorId);
    const entityId = new Types.ObjectId(event.outingId);
    // A recipient is processed once even if multiple membership paths select them.
    for (const recipientId of new Set(event.recipientIds)) {
      if (recipientId === event.actorId) continue;
      try {
        const to = new Types.ObjectId(recipientId);
        if (await friendBlockRepository.isBlockedBetween(to, actorId)) continue;
        const access = (await friendOutingService.notificationVisibility(recipientId, [event.outingId])).get(event.outingId);
        if (!access?.visible) continue;
        // notificationService enforces generic outing content even if a caller later supplies custom push text.
        await notificationService.emit({ space: 'friends', to, actorId, entityId, type: event.type });
      } catch {
        // Never include outing text, participant profiles, money, or arbitrary thrown messages in logs.
        logger.warn('Outing notification skipped', { type: event.type });
      }
    }
  });
}
