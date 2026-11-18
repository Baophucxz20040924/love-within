import { Types } from 'mongoose';
import { Couple } from '../models/Couple.js';
import { MOMENT_SCHEDULE_VERSION } from '../models/DuoMoment.js';
import { momentRepository } from '../repositories/moment.repository.js';
import { dailyRewardService } from './dailyReward.service.js';
import { notificationService } from './notification.service.js';
import { DUO_MOMENT_QUEST_KEY, questService } from './quest.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import { logger } from '../utils/logger.js';

/** Work is marked by the photo CAS itself, not by an enqueue after the response. */
export const momentEffectsService = {
  async recover(coupleId?: Types.ObjectId, limit = 10): Promise<number> {
    let count = 0;
    for (let i = 0; i < Math.min(limit, 20); i++) {
      const day = await momentRepository.claimEffects(coupleId);
      if (!day) break;
      const token = day.effectsLeaseToken!;
      let completed = false;
      try {
        const couple = await Couple.findById(day.coupleId).exec();
        if (!couple) throw new Error('Moment source couple unavailable');
        await dailyRewardService.settleMoments(couple, day);
        await questService.refresh(couple, DUO_MOMENT_QUEST_KEY, day.localDate);
        for (const session of day.sessions ?? []) {
          for (const post of session.posts) {
            if (post.effectsBoth === undefined || post.effectsCompletedAt) continue;
            const both = post.effectsBoth;
            const timely = day.scheduleVersion === MOMENT_SCHEDULE_VERSION && session.rewardEndsAt &&
              post.postedAt >= session.promptAt && post.postedAt < session.rewardEndsAt;
            if (both || timely) {
              await notificationService.toPartner(couple, post.userId, {
                requirePersistence: true,
                type: both ? 'moment_both' : 'moment_posted', entityId: day._id,
                eventKey: `${day._id}:${session.id}:${post.userId}`,
                target: { kind: 'moment', dayId: String(day._id), localDate: day.localDate, sessionId: session.id },
                push: {
                  body: both ? (name) => `${name} cũng đã chụp Khoảnh khắc. Xem ảnh của hai bạn` :
                    (name) => `${name} đã chụp Khoảnh khắc. Cùng chụp trước hạn để nhận thưởng đủ đôi!`,
                  url: `/moments?date=${day.localDate}&session=${session.id}`,
                  tag: `moment:${day.localDate}:${session.id}`,
                  expiresAt: both ? undefined : session.rewardEndsAt!.toISOString(),
                },
              });
            }
            await momentRepository.completePostEffects(day._id, token, session.id, post.userId);
          }
        }
        await realtimeAudience.couple(couple._id, ['moments', 'wallet', 'quests']);
        completed = true;
        count++;
      } catch {
        // No source contents, object keys, signed URLs, or credentials in worker errors.
        logger.warn('Moment effects pending retry');
      } finally {
        await momentRepository.releaseEffects(day._id, token, completed);
      }
    }
    return count;
  },
};
