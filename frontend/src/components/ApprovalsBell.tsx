import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { useApprovals } from '../features/approvals/useApprovals';

/** Header bell: number of things waiting for MY approval (partner's water photos + proposals). */
export function ApprovalsBell() {
  const { count } = useApprovals();
  const label = count > 0 ? `${count} việc cần bạn duyệt` : 'Thông báo';
  return (
    <Link to="/approvals" className="icon-btn" aria-label={label}>
      <Icon name="bell" />
      {count > 0 && <span className="count-badge">{count > 9 ? '9+' : count}</span>}
    </Link>
  );
}
