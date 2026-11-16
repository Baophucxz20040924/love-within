import { Page } from '../components/StatusViews';
import { PushSettingsPanel, type PushGroupRow } from '../features/push/PushSettingsPanel';

/** Couple settings groups shown here (users.pushSettings.couple). */
const GROUPS: PushGroupRow[] = [
  { key: 'approvals', icon: 'check', label: 'Cần duyệt', hint: 'Nước chờ duyệt, đề xuất, đổi quà' },
  { key: 'stories', icon: 'bookOpen', label: 'Kỷ niệm', hint: 'Bài viết, bình luận, câu hỏi mỗi ngày, thư hẹn giờ, bucket list' },
  { key: 'reminders', icon: 'calendar', label: 'Nhắc sự kiện', hint: 'Sự kiện mới, trước 7 ngày, 1 ngày, đúng ngày và 1 giờ trước' },
  { key: 'nudges', icon: 'heart', label: 'Nhớ bạn', hint: 'Khi người ấy chạm nút tim. Các lần trong ngày gộp thành một thông báo' },
  { key: 'moments', icon: 'camera', label: 'Khoảnh khắc', hint: 'Tới giờ chụp mỗi ngày, khi người ấy đã chụp. Tắt thì vẫn chụp được trong app' },
];

/** /profile/notifications — Hồ sơ → "Thông báo": push on this device, groups, lock-screen text, quiet hours, test. */
export function NotificationSettingsPage() {
  return (
    <Page title="Thông báo" back="/profile">
      <p className="text-sm text-muted">Báo ra màn hình khóa khi app đang đóng: người ấy gửi nước chờ duyệt, đăng bài, trả lời câu hỏi, nhớ bạn, sự kiện sắp tới, tới giờ Khoảnh khắc.</p>
      <PushSettingsPanel
        space="couple"
        groups={GROUPS}
        quietHint="Trong giờ yên lặng máy không báo. Trang chủ và hộp Cần duyệt vẫn có đủ khi bạn mở app."
      />
    </Page>
  );
}
