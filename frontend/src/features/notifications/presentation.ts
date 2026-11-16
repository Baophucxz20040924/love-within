import type { IconName } from '../../components/Icon';
import type { CoupleNotification } from './api';

const LABELS: Record<string, string> = {
  water_pending: 'đã gửi ảnh uống nước cần bạn duyệt.',
  proposal_created: 'đã gửi một đề xuất cần bạn duyệt.',
  redemption_requested: 'đã gửi yêu cầu đổi quà.',
  redemption_answered: 'đã trả lời yêu cầu đổi quà.',
  couple_story: 'đã chia sẻ một kỷ niệm.',
  couple_comment: 'đã bình luận về một kỷ niệm.',
  question_answered: 'đã trả lời câu hỏi của hai bạn.',
  question_both: 'Cả hai đã trả lời câu hỏi.',
  letter_ready: 'Một lá thư đã đến ngày mở.',
  letter_opened: 'đã mở lá thư của bạn.',
  event_created: 'đã thêm một sự kiện.',
  event_reminder: 'Sự kiện của hai bạn sắp tới.',
  nudge: 'đã gửi bạn một lời nhắn yêu thương.',
  bucket_done: 'đã hoàn thành một điều trong danh sách.',
  moment_prompt: 'Đến giờ chụp khoảnh khắc của hai bạn.',
  moment_posted: 'đã chụp khoảnh khắc hôm nay.',
  moment_both: 'Cả hai đã chụp khoảnh khắc.',
  savings_reached: 'Quỹ tiết kiệm đã đạt mục tiêu.',
};

export function notificationLabel(type: string): string {
  return LABELS[type] ?? 'Bạn có hoạt động mới trong không gian đôi.';
}

export function notificationIcon(type: string): IconName {
  if (type.startsWith('moment_')) return 'camera';
  if (type.startsWith('question_') || type === 'couple_comment') return 'messageCircle';
  if (type.startsWith('event_')) return 'calendar';
  if (type === 'water_pending') return 'droplet';
  if (type === 'redemption_requested' || type === 'redemption_answered') return 'gift';
  return 'bell';
}

/** Only known in-app routes are produced; the server never supplies a URL. */
export function notificationTarget(n: CoupleNotification): string {
  const t = n.target;
  if (!t || typeof t !== 'object') return '/';
  // A path segment of '.' or '..' is normalized by the browser even when percent encoded.
  const id = 'id' in t && typeof t.id === 'string' && t.id.length > 0 && t.id !== '.' && t.id !== '..' ? encodeURIComponent(t.id) : null;
  switch (t.kind) {
    case 'approval': return '/notifications?filter=approvals';
    case 'story': return id ? `/stories/${id}` : '/stories';
    case 'question': return id ? `/questions/${id}` : '/questions';
    case 'letter': return id ? `/letters/${id}` : '/letters';
    case 'event': return '/events';
    case 'nudge': return '/';
    case 'bucket': return '/quests/bucket';
    case 'savings': return id ? `/savings/${id}` : '/savings';
    case 'moment': {
      if (typeof t.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.localDate)) return '/moments';
      const params = new URLSearchParams({ date: t.localDate });
      if (typeof t.sessionId === 'string' && t.sessionId) params.set('session', t.sessionId);
      return `/moments?${params.toString()}`;
    }
    default: return '/';
  }
}
