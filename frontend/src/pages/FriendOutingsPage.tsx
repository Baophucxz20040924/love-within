import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { formatVnd } from '../lib/format';
import { OUTINGS_KEY, outingsApi } from '../features/friends/outings/api';
import { CreateOutingSheet } from '../features/friends/outings/OutingForms';
import { phaseLabel, outingDate } from '../features/friends/outings/presentation';
import '../features/friends/outings/outings.css';

export function FriendOutingsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useInfiniteQuery({ queryKey: OUTINGS_KEY, queryFn: ({ pageParam }) => outingsApi.list(pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, refetchOnWindowFocus: true });
  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  const invitations = items.filter(item => item.myMembership === 'pending');
  const joined = items.filter(item => item.myMembership !== 'pending');
  return <Page title="Chia tiền" subtitle="Hội bạn bè" back="/friends/me" bell={false} actions={<button type="button" className="icon-btn" aria-label="Cập nhật danh sách buổi" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" size={20} /></button>}>
    <div className="outings-page">
      <section className="outing-intro"><div className="outing-intro__icon"><Icon name="coins" size={28} /></div><p className="outing-eyebrow">ĐI CHƠI CÙNG NHAU</p><h2>Vui hết mình.<br />Chia tiền rõ ràng.</h2><p>Mỗi khoản một phần, mỗi người cùng đồng ý.<br />Để buổi vui chỉ còn chuyện đáng nhớ.</p><button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} /> Tạo buổi chia tiền</button><span className="outing-intro__note">Không chuyển tiền thật trong ứng dụng</span></section>
      {query.isLoading && <Skeleton height={116} count={3} />}
      {query.isError && <ErrorState message="Chưa tải được các buổi chia tiền. Dữ liệu đã lưu không bị thay đổi." onRetry={() => void query.refetch()} />}
      {!!invitations.length && <section className="outing-list-section"><div className="outing-section-head"><h2>Lời mời cũ</h2><span className="outing-count">{invitations.length}</span></div><p className="outing-hint">Đây là lời mời được tạo trước thay đổi mới. Bạn được xem sổ sau khi nhận lời; nhận lời không phải đồng ý chốt tiền.</p><div className="outing-list">{invitations.map(item => <Link key={item.id} to={`/friends/outings/${item.id}`} className="outing-list-card outing-list-card--invited"><span className="outing-list-card__icon"><Icon name="users" size={22} /></span><div><span className="outing-status">Chờ bạn nhận lời</span><h3>{item.title}</h3><p>{outingDate(item.outingDate)}</p></div><Icon name="chevronRight" size={20} /></Link>)}</div></section>}
      <section className="outing-list-section"><div className="outing-section-head"><h2>Các buổi của bạn</h2><span className="outing-hint">Rõ từ lúc ghi đến lúc nhận</span></div>
        {query.isSuccess && !joined.length && <div className="outing-empty"><span className="outing-empty__icon"><Icon name="calendar" size={28} /></span><h3>Buổi vui tiếp theo, bắt đầu ở đây</h3><p>Tạo một buổi, thêm bạn bè trực tiếp rồi ghi những khoản bạn đã trả. Mỗi người vẫn tự kiểm tra và đồng ý chốt nợ.</p><button className="btn btn-outline" onClick={() => setCreating(true)}>Tạo buổi đầu tiên</button></div>}
        <div className="outing-list">{joined.map(item => <Link key={item.id} to={`/friends/outings/${item.id}`} className="outing-list-card"><span className="outing-list-card__icon"><Icon name={item.phase === 'completed' ? 'check' : 'coins'} size={22} /></span><div><span className="outing-status">{item.myMembership === 'declined' ? 'Đã từ chối lời mời cũ' : phaseLabel[item.phase]}</span><h3>{item.title}</h3><p>{outingDate(item.outingDate)}{item.memberCount !== undefined ? ` · ${item.memberCount} thành viên` : ''}</p>{item.totalExpenses !== undefined && <p className="outing-list-card__total">Tổng buổi <strong>{formatVnd(item.totalExpenses)}</strong></p>}</div><Icon name="chevronRight" size={20} /></Link>)}</div>
      </section>
      {query.hasNextPage && <button type="button" className="btn btn-outline btn-block" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm buổi'}</button>}
    </div>
    {creating && <CreateOutingSheet onClose={() => setCreating(false)} onSaved={view => navigate(`/friends/outings/${view.id}`)} />}
  </Page>;
}
