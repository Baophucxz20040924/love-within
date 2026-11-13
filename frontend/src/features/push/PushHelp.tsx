import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { detectDevice, isStandalone } from '../../lib/installPrompt';

/** Notifications blocked (Notification.permission === 'denied'): where to allow them again on this kind of device. */
export function deniedSteps(): string {
  const { platform } = detectDevice();
  const app = isStandalone();
  if (platform === 'ios') return 'Mở Cài đặt của iPhone → Thông báo → Look Within → bật Cho phép thông báo, rồi mở lại app.';
  if (platform === 'android' && app) return 'Mở Cài đặt của điện thoại → Ứng dụng → Look Within → Thông báo → bật, rồi mở lại app.';
  if (platform === 'android') return 'Chạm biểu tượng bên trái thanh địa chỉ (hoặc ⋮ → Cài đặt trang web) → Thông báo → Cho phép, rồi tải lại trang.';
  return 'Bấm biểu tượng bên trái thanh địa chỉ → Thông báo → Cho phép, rồi tải lại trang.';
}

/** Why the device switch cannot be used here, and what to do. Never names a space. */
export function PushDeviceHelp({ state, serverEnabled }: { state: string; serverEnabled: boolean | null }) {
  if (serverEnabled === false) {
    return (
      <p className="callout">
        <Icon name="alert" size={16} />
        <span>Máy chủ chưa bật thông báo. Bạn vẫn chỉnh được các loại thông báo bên dưới.</span>
      </p>
    );
  }
  if (state === 'ios-install') {
    return (
      <div className="callout push-help">
        <Icon name="smartphone" size={16} />
        <span>
          Trên iPhone và iPad, thông báo chỉ dùng được khi Look Within đã được thêm vào Màn hình chính và mở từ biểu tượng đó (iOS 16.4 trở lên).{' '}
          <Link to="/install" className="text-link">
            Xem cách cài app
          </Link>
        </span>
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <p className="callout push-help">
        <Icon name="bellOff" size={16} />
        <span>
          <strong>Thông báo đang bị chặn trên máy này.</strong> {deniedSteps()}
        </span>
      </p>
    );
  }
  if (state === 'unsupported') {
    return (
      <p className="callout">
        <Icon name="alert" size={16} />
        <span>Trình duyệt này chưa nhận được thông báo. Hãy dùng Chrome trên Android, hoặc app đã cài trên iPhone.</span>
      </p>
    );
  }
  return null;
}
