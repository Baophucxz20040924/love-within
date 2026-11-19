import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import type { FriendEventDetail } from '../../../lib/types';
import { OUTINGS_KEY, outingsApi } from './api';
import { CreateOutingSheet } from './OutingForms';
import './outings.css';

/** Event is only an entry point. RSVP never silently enrolls anyone into the ledger. */
export function EventOutingEntry({ event }: { event: FriendEventDetail }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: [...OUTINGS_KEY, 'event', event.id], queryFn: ({ signal }) => outingsApi.forEvent(event.id, signal), refetchOnWindowFocus: true });
  const existing = query.data?.items[0];
  return <section className="outing-event-entry" aria-labelledby="outing-event-title"><span className="outing-list-card__icon"><Icon name="coins" size={23} /></span><div><p className="outing-entry-kicker">CHO BUỔI ĐI CHƠI NÀY</p><h2 id="outing-event-title">Vui cùng nhau, chia tiền rõ ràng</h2><p>Chọn bạn bè để thêm trực tiếp vào sổ. Mỗi người tự ghi khoản mình trả và tự đồng ý chốt nợ. Sổ vẫn giữ nếu kèo bị hủy hoặc xóa.</p>
    {query.isLoading ? <p role="status">Đang kiểm tra sổ chia tiền…</p> : query.isError ? <button className="btn btn-outline" onClick={() => void query.refetch()}>Thử lại mục chia tiền</button> : existing ? <Link className="btn btn-primary" to={`/friends/outings/${existing.id}`}>Mở sổ chia tiền <Icon name="chevronRight" size={17} /></Link> : event.isMine ? <button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={17} /> Tạo buổi chia tiền</button> : <p className="outing-hint">Chủ kèo có thể tạo sổ và thêm bạn vào buổi chia tiền.</p>}
    </div>{open && <CreateOutingSheet event={event} onClose={() => setOpen(false)} onSaved={view => navigate(`/friends/outings/${view.id}`)} />}</section>;
}
