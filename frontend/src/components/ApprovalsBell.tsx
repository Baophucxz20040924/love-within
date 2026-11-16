import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { useCoupleNotificationUnread } from '../features/notifications/useCoupleNotifications';

/** The bell counts unseen activity; approvals are counted separately in their filter. */
export function ApprovalsBell() {
  const { data, isError } = useCoupleNotificationUnread();
  const count = data?.notifications ?? 0;
  const approximate = data?.notificationsSaturated ?? false;
  const label = isError ? 'Thông báo (chưa cập nhật được số mới)' : count > 0 ? `${count}${approximate ? ' trở lên' : ''} thông báo mới` : approximate ? 'Có thông báo mới' : 'Thông báo';
  return (
    <Link to="/notifications" className="icon-btn" aria-label={label}>
      <Icon name="bell" />
      {(count > 0 || approximate) && <span className="count-badge">{count > 9 ? '9+' : approximate ? (count > 0 ? `${count}+` : '•') : count}</span>}
    </Link>
  );
}
