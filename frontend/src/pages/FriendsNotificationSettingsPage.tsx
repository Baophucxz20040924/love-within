import { Page } from '../components/StatusViews';
import { PushSettingsPanel, type PushGroupRow } from '../features/push/PushSettingsPanel';

/**
 * Friends settings groups shown here (users.pushSettings.friends). Groups whose feature does not exist yet are not listed:
 * BB10 adds `messages` ("Tin nhắn").
 */
const GROUPS: PushGroupRow[] = [
  { key: 'social', icon: 'users', label: 'Bạn bè', hint: 'Lời mời kết bạn, cảm xúc, bình luận, bình chọn đã kết thúc, người vào hội qua link của bạn' },
  { key: 'events', icon: 'calendar', label: 'Kèo', hint: 'Lời mời đi kèo, người sẽ đi, đổi giờ hoặc địa điểm, hủy kèo, thảo luận, nhắc 2 giờ trước giờ hẹn' },
];

/** /friends/me/notifications — Tôi → "Cài đặt thông báo". Content is hidden on the lock screen by default. */
export function FriendsNotificationSettingsPage() {
  return (
    <Page title="Cài đặt thông báo" back="/friends/me">
      <p className="text-sm text-muted">Báo ra màn hình khóa khi app đang đóng: lời mời kết bạn, bình luận, cảm xúc về bài viết của bạn, kèo.</p>
      <PushSettingsPanel
        space="friends"
        groups={GROUPS}
        previewText={{
          on: 'Màn hình khóa hiện tên người và việc họ vừa làm, ví dụ “Long đã bình luận về bài viết của bạn”. Ai cầm điện thoại của bạn cũng đọc được.',
          off: 'Đang ẩn: màn hình khóa chỉ hiện “Love Within · Bạn có thông báo mới”, không có tên ai hay nội dung gì. Người khác nhìn thấy điện thoại của bạn cũng không biết là gì. Chạm vào để mở trang Thông báo.',
        }}
        quietHint="Trong giờ yên lặng máy không báo. Trang Thông báo trong app vẫn có đủ."
      />
    </Page>
  );
}
