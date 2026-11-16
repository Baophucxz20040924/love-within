import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { savingsApi, savingsListOptions, SAVINGS_SUGGESTION_KEY } from '../features/savings/api';
import { SavingsGoalSheet } from '../features/savings/SavingsSheets';
import { SavingsMembers, SavingsProgress } from '../features/savings/SavingsViews';
import { formatDay } from '../lib/format';

export function SavingsPage() {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [creating, setCreating] = useState(false);
  const list = useInfiniteQuery(savingsListOptions({ status: tab }));
  // Private to the caller, never embedded in the shared goal or Home pulse.
  const suggestion = useQuery({ queryKey: SAVINGS_SUGGESTION_KEY, queryFn: savingsApi.suggest });
  const items = list.data?.pages.flatMap(page => page.items) ?? [];
  return <Page title="Quỹ chung" subtitle="Cùng góp cho điều hai bạn mong muốn" back="/finance">
    <p className="text-sm text-muted">App chỉ ghi lại, không giữ hay chuyển tiền. Không cần liên kết ngân hàng để góp thủ công.</p>
    <div className="btn-row"><Link to="/notifications?filter=approvals" className="btn btn-outline">Cần duyệt</Link><button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} /> Tạo quỹ</button></div>
    {suggestion.data?.suggestion && <aside className="card stack" aria-label="Gợi ý riêng cho bạn">
      <p className="card__title">Gợi ý riêng cho bạn</p>
      <p>{suggestion.data.suggestion.message}</p>
      <p className="text-sm text-muted">Chỉ dựa trên giao dịch đã đồng bộ của bạn, không dùng dòng tiền của người ấy. Chọn một quỹ bên dưới để góp.</p>
    </aside>}
    {suggestion.isError && <div className="row row--between"><p className="text-sm text-muted">Chưa tải được gợi ý riêng.</p><button type="button" className="btn btn-ghost" onClick={() => void suggestion.refetch()}>Thử lại gợi ý</button></div>}
    <SegmentedControl mode="radio" ariaLabel="Trạng thái quỹ" value={tab} onChange={setTab} options={[{ value: 'open', label: 'Đang mở' }, { value: 'closed', label: 'Đã đóng' }]} />
    {list.isLoading && <Skeleton height={180} count={2} />}
    {list.isError && !list.data && <ErrorState onRetry={() => void list.refetch()} />}
    {list.isSuccess && items.length === 0 && <div className="card"><EmptyState title={tab === 'closed' ? 'Chưa có quỹ đã đóng' : 'Chưa có quỹ chung'} hint={tab === 'closed' ? 'Quỹ đóng sẽ được giữ ở đây để xem lại.' : 'Tạo đề xuất đầu tiên. Quỹ xuất hiện khi cả hai đồng ý.'} action={tab === 'open' ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Tạo quỹ đầu tiên</button> : undefined} /></div>}
    {items.map((goal) => <Link key={goal.id} to={`/savings/${goal.id}`} className="card card--link savings-card">
      <div className="row row--between"><h2 className="card__title savings-title">{goal.emoji} {goal.title}</h2>{goal.pinned && <Icon name="pin" size={18} />}</div>
      <SavingsProgress goal={goal} />
      <SavingsMembers goal={goal} />
      {goal.dueOn && <p className="text-sm text-muted">Hạn {formatDay(goal.dueOn)}</p>}
    </Link>)}
    {list.isFetchNextPageError && <p role="alert">Chưa tải được trang tiếp theo. Các quỹ đã tải vẫn được giữ.</p>}
    {list.hasNextPage && <button type="button" className="btn btn-outline btn-block" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Đang tải…' : list.isFetchNextPageError ? 'Thử lại trang tiếp theo' : 'Xem thêm quỹ'}</button>}
    {creating && <SavingsGoalSheet onClose={() => setCreating(false)} />}
  </Page>;
}
