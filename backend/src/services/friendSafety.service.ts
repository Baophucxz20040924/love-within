import type { Types } from 'mongoose';
import { AUTO_HIDE_REPORTS, type ReportReason, type ReportTarget } from '../models/FriendSafety.js';
import type { UserDoc } from '../models/User.js';
import { friendshipRepository } from '../repositories/friendship.repository.js';
import {
  friendBlockRepository,
  friendHiddenStoryRepository,
  friendReportRepository,
} from '../repositories/friendSafety.repository.js';
import { friendEventCommentRepository, friendEventRepository } from '../repositories/friendEvent.repository.js';
import { friendStoryCommentRepository, friendStoryRepository } from '../repositories/friendStory.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { friendEventService } from './friendEvent.service.js';
import { friendStoryService } from './friendStory.service.js';
import { notificationService } from './notification.service.js';
import { realtimeAudience } from './realtimeAudience.service.js';
import { captureRelationshipAudience, invalidateRelationshipAudience } from './friendOuting.service.js';
import { profileOf, profileService, type PublicProfile } from './profile.service.js';

const NOT_MEMBER = 'Không tìm thấy người này trong Hội bạn bè';

export interface BlockedView {
  user: PublicProfile;
  blockedAt: string;
}

export interface ReportInput {
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  note: string;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** What is being reported and whose it is. The caller must be able to see it (404 otherwise). */
async function resolveTarget(me: UserDoc, input: ReportInput): Promise<{ targetId: Types.ObjectId; ownerId: Types.ObjectId }> {
  switch (input.targetType) {
    case 'user': {
      if (me._id.equals(input.targetId)) throw Errors.badRequest('Không thể báo cáo chính mình');
      const user = await userRepository.findById(input.targetId);
      if (!user || !user.friendsJoinedAt || (await friendBlockRepository.isBlockedBetween(me._id, user._id))) {
        throw Errors.notFound(NOT_MEMBER);
      }
      return { targetId: user._id, ownerId: user._id };
    }
    case 'story': {
      const story = await friendStoryService.visibleStory(me, input.targetId);
      if (story.authorId.equals(me._id)) throw Errors.badRequest('Bạn không thể báo cáo bài viết của chính mình');
      return { targetId: story._id, ownerId: story.authorId };
    }
    case 'comment': {
      const { comment } = await friendStoryService.visibleComment(me, input.targetId);
      if (comment.authorId.equals(me._id)) throw Errors.badRequest('Bạn không thể báo cáo bình luận của chính mình');
      return { targetId: comment._id, ownerId: comment.authorId };
    }
    case 'event': {
      const event = await friendEventService.visibleEvent(me, input.targetId);
      if (event.creatorId.equals(me._id)) throw Errors.badRequest('Bạn không thể báo cáo kèo của chính mình');
      return { targetId: event._id, ownerId: event.creatorId };
    }
    case 'event_comment': {
      const { comment } = await friendEventService.visibleComment(me, input.targetId);
      if (comment.authorId.equals(me._id)) throw Errors.badRequest('Bạn không thể báo cáo bình luận của chính mình');
      return { targetId: comment._id, ownerId: comment.authorId };
    }
  }
}

/** Hide reported content pending review (true the first time). */
function hideByReports(type: Exclude<ReportTarget, 'user'>, id: Types.ObjectId): Promise<boolean> {
  switch (type) {
    case 'story':
      return friendStoryRepository.hideByReports(id);
    case 'comment':
      return friendStoryCommentRepository.hideByReports(id);
    case 'event':
      return friendEventRepository.hideByReports(id);
    case 'event_comment':
      return friendEventCommentRepository.hideByReports(id);
  }
}

/** Blocks, reports and hidden posts in the friends space (plan/ENGINEERING_WORKFLOW.md, BB2). */
export const friendSafetyService = {
  /**
   * Block someone. Works both ways at once: the friendship or pending request is removed, the two stop
   * finding and seeing each other, and their notifications about each other are forgotten. The blocked
   * person is not told. Blocking twice is fine.
   */
  async block(me: UserDoc, targetId: string): Promise<void> {
    if (me._id.equals(targetId)) throw Errors.badRequest('Không thể chặn chính mình');
    const target = await userRepository.findById(targetId);
    if (!target || !target.friendsJoinedAt) throw Errors.notFound(NOT_MEMBER);
    const audience = await captureRelationshipAudience(me._id.toString(), targetId);
    await friendBlockRepository.block(me._id, target._id);
    invalidateRelationshipAudience(audience, true);
    await friendshipRepository.deleteBetween(me._id, target._id);
    await notificationService.forgetBetween(me._id, target._id);
    logger.info('Friends-space user blocked', { userId: me._id.toString(), blockedId: targetId });
  },

  /** Unblocking does not make the two friends again. */
  async unblock(me: UserDoc, targetId: string): Promise<void> {
    // Clean up a friendship left by an interrupted block BEFORE removing the authoritative denial.
    // Failure leaves the block in place; unblocking must never restore a stale friendship/request.
    if (!(await friendBlockRepository.isBlockedBy(me._id, targetId))) throw Errors.notFound('Bạn chưa chặn người này');
    const audience = await captureRelationshipAudience(me._id.toString(), targetId);
    await friendshipRepository.deleteBetween(me._id, targetId);
    invalidateRelationshipAudience(audience, true);
    if (!(await friendBlockRepository.unblock(me._id, targetId))) throw Errors.notFound('Bạn chưa chặn người này');
    // Pending outing invitations may become eligible again only after the block is removed.
    const after = await captureRelationshipAudience(me._id.toString(), targetId);
    invalidateRelationshipAudience([...new Set([...audience, ...after])], true);
    logger.info('Friends-space user unblocked', { userId: me._id.toString(), unblockedId: targetId });
  },

  /** People I blocked (not the ones who blocked me), newest first. */
  async listBlocked(me: UserDoc): Promise<BlockedView[]> {
    const rows = await friendBlockRepository.listByBlocker(me._id);
    const profiles = await profileService.load(rows.map((r) => r.blockedId));
    return rows.map((r) => ({ user: profileOf(profiles, r.blockedId), blockedAt: r.createdAt.toISOString() }));
  },

  /**
   * Report a user, post, comment, event or event comment. One open report per person per target. Once 3 different people
   * reported content it is hidden from everyone but its author until the owner reviews it
   * (`npm run reports`). The reported person never learns who reported them.
   */
  async report(me: UserDoc, input: ReportInput): Promise<{ hidden: boolean }> {
    const { targetId, ownerId } = await resolveTarget(me, input);
    try {
      await friendReportRepository.create({
        reporterId: me._id,
        targetType: input.targetType,
        targetId,
        targetOwnerId: ownerId,
        reason: input.reason,
        note: input.note.trim(),
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw Errors.conflict('Bạn đã báo cáo nội dung này rồi');
      throw err;
    }
    logger.warn('Friends-space content reported', {
      userId: me._id.toString(),
      targetType: input.targetType,
      targetId: targetId.toString(),
      reason: input.reason,
    });

    let hidden = false;
    if (input.targetType !== 'user' && (await friendReportRepository.countOpen(input.targetType, targetId)) >= AUTO_HIDE_REPORTS) {
      // Resolve the audience before hiding, while the original content remains visible.
      let event: Awaited<ReturnType<typeof friendEventService.visibleEvent>> | undefined;
      let story: Awaited<ReturnType<typeof friendStoryService.visibleStory>> | undefined;
      if (input.targetType === 'event') event = await friendEventService.visibleEvent(me, input.targetId).catch(() => undefined);
      if (input.targetType === 'event_comment') event = (await friendEventService.visibleComment(me, input.targetId).catch(() => undefined))?.event;
      if (input.targetType === 'story') story = await friendStoryService.visibleStory(me, input.targetId).catch(() => undefined);
      if (input.targetType === 'comment') story = (await friendStoryService.visibleComment(me, input.targetId).catch(() => undefined))?.story;
      hidden = await hideByReports(input.targetType, targetId);
      if (hidden && story) {
        if (story.hiddenByReportsAt) await realtimeAudience.own(story.authorId.toString(), 'friends', ['friend-posts'], true).catch(() => {});
        else await realtimeAudience.friendsOf(story.authorId.toString(), ['friend-posts'], true).catch(() => {});
      }
      if (hidden && event) {
        if (event.hiddenByReportsAt) await realtimeAudience.own(event.creatorId.toString(), 'friends', ['friend-events'], true).catch(() => {});
        else await realtimeAudience.event(event, ['friend-events'], true).catch(() => {});
      }
      if (hidden) logger.warn('Friends-space content hidden after reports', { targetType: input.targetType, targetId: targetId.toString() });
    }
    return { hidden };
  },

  /** Hide a friend's post from my own feed (it stays reachable by link and on their profile). */
  async hideStory(me: UserDoc, storyId: string): Promise<void> {
    const story = await friendStoryService.visibleStory(me, storyId);
    if (story.authorId.equals(me._id)) throw Errors.badRequest('Đây là bài viết của bạn');
    await friendHiddenStoryRepository.hide(me._id, story._id);
    await realtimeAudience.own(me._id.toString(), 'friends', ['friend-posts']).catch(() => {});
  },

  async unhideStory(me: UserDoc, storyId: string): Promise<void> {
    await friendHiddenStoryRepository.unhide(me._id, storyId);
    await realtimeAudience.own(me._id.toString(), 'friends', ['friend-posts']).catch(() => {});
  },
};
