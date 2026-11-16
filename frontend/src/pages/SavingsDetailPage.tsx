import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { useCouplePeople } from '../features/questions/useCouplePeople';
import { refreshSavings, savingsApi, savingsDetailKey, savingsError } from '../features/savings/api';
import { SavingsEntrySheet, SavingsGoalSheet } from '../features/savings/SavingsSheets';
import { SavingsCelebration, SavingsMembers, SavingsProgress } from '../features/savings/SavingsViews';
import { formatDay, formatNetVnd } from '../lib/format';
import { assertCurrentSession } from '../lib/apiClient';
import { tokenStore } from '../lib/tokenStore';
import type { SavingsEntry } from '../lib/types';

/** Ignore delayed completions after unmount or a login change. */
function useMutationSession() {
  const [generation] = useState(() => tokenStore.generation());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return { generation, current: () => mounted.current && tokenStore.isCurrent(generation) };
}

export function SavingsDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const session = useMutationSession();
  const { partnerName } = useCouplePeople();
  const [sheet, setSheet] = useState<'give' | 'withdraw' | 'update' | 'close' | null>(null);
  const [deleting, setDeleting] = useState<SavingsEntry | null>(null);
  const detail = useInfiniteQuery({
    queryKey: savingsDetailKey(id),
    queryFn: ({ pageParam }) => savingsApi.detail(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  // Totals always come from the server's whole-goal aggregation, not the loaded entry pages.
  const goal = detail.data?.pages[0]?.goal;
  const entries = detail.data?.pages.flatMap((p) => p.entries) ?? [];
  const closed = goal?.status === 'closed';
  const pin = useMutation({
    mutationFn: () => { assertCurrentSession(session.generation); return savingsApi.pin(goal!.pinned ? null : id); },
    onSuccess: async () => { if (!session.current()) return; toast.success(goal?.pinned ? 'Đã bỏ ghim' : 'Đã ghim lên Trang chủ'); await refreshSavings(qc); },
    onError: async (err) => { if (!session.current()) return; toast.error(savingsError(err)); await refreshSavings(qc); },
  });
  const remove = useMutation({
    mutationFn: () => { assertCurrentSession(session.generation); return savingsApi.removeEntry(id, deleting!.id); },
    onSuccess: async () => { if (!session.current()) return; setDeleting(null); toast.success('Đã xóa khoản ghi'); await refreshSavings(qc); },
    onError: async (err) => { if (!session.current()) return; toast.error(savingsError(err)); await refreshSavings(qc); },
  });
  const pinFromCurrentSession = () => { if (session.current()) pin.mutate(); };
  const removeFromCurrentSession = () => { if (session.current()) remove.mutate(); };
  return <Page title={goal ? `${goal.emoji} ${goal.title}` : 'Chi tiết quỹ'} back="/savings">
    {detail.isLoading && <Skeleton height={220} count={2} />}
    {detail.isError && !detail.isFetchNextPageError && <ErrorState onRetry={() => void detail.refetch()} />}
    {goal && <>
      <section className="card savings-card" aria-label="Tiến độ quỹ">
        <SavingsProgress goal={goal} />
        <SavingsMembers goal={goal} />
        {goal.dueOn && <p className="text-sm text-muted">Hạn {formatDay(goal.dueOn)}</p>}
        {goal.forecastOn && !closed && <p className="text-sm text-muted">Với tốc độ 30 ngày qua, ước tính đạt mục tiêu khoảng tháng {Number(goal.forecastOn.slice(5, 7))}/{goal.forecastOn.slice(0, 4)}. Đây là ước tính, không phải cam kết.</p>}
        {!goal.forecastOn && goal.status === 'active' && <p className="text-sm text-muted">Chưa đủ tốc độ góp ròng dương trong 30 ngày qua để dự báo.</p>}
        <p className="text-sm text-muted">App chỉ ghi lại, không chuyển tiền.</p>
      </section>
      {closed ? <p className="card text-sm" role="status">Quỹ đã đóng, chỉ xem lại lịch sử. Không thể góp, rút hay xóa khoản.</p> : <>
        <div className="btn-row"><button type="button" className="btn btn-primary" onClick={() => setSheet('give')}>Góp tiền</button><button type="button" className="btn btn-outline" onClick={() => setSheet('withdraw')}>Rút tiền</button></div>
        <div className="savings-actions"><button type="button" className="btn btn-outline" disabled={pin.isPending} onClick={pinFromCurrentSession}>{goal.pinned ? 'Bỏ ghim' : 'Ghim lên Trang chủ'}</button><button type="button" className="btn btn-ghost" onClick={() => setSheet('update')}>Đổi mục tiêu / hạn</button><button type="button" className="btn btn-ghost" onClick={() => setSheet('close')}>Đóng quỹ</button></div>
        <p className="text-sm text-muted">Đổi mục tiêu, hạn hoặc đóng quỹ cần cả hai đồng ý. <Link to="/notifications?filter=approvals" className="text-link">Xem Cần duyệt</Link></p>
      </>}
      {goal.reachedAt && <section className="card stack" aria-label="Cột mốc của quỹ">
        <h2 className="card__title">Hai bạn đã từng chạm mục tiêu!</h2>
        <p className="text-sm text-muted">Lưu lại điều đáng nhớ hoặc lên kế hoạch cùng nhau.</p>
        <div className="savings-actions"><Link className="btn btn-outline" to="/quests/bucket?compose=1">Thêm vào Bucket list</Link><Link className="btn btn-outline" to="/stories?compose=1">Viết kỷ niệm</Link></div>
      </section>}
      <SavingsCelebration key={goal.id} goal={goal} />
      <h2 className="section-title">Lịch sử góp / rút</h2>
      {entries.length === 0 && <div className="card"><EmptyState title="Chưa có khoản góp" hint={closed ? 'Quỹ này không có khoản ghi nào.' : 'Ghi khoản đầu tiên bằng nút Góp tiền.'} /></div>}
      {entries.length > 0 && <div className="list">{entries.map((entry) => <article key={entry.id} className="list__item savings-entry">
        <div className="list__body">
          <p className="list__label">{entry.isMine ? 'Bạn' : partnerName} · {entry.amountVnd < 0 ? 'Rút' : 'Góp'}</p>
          <p className="savings-entry__amount">{formatNetVnd(entry.amountVnd)}</p>
          <p className="list__meta">{formatDay(entry.occurredOn)} · {entry.source === 'bank' ? 'Từ giao dịch ngân hàng' : 'Ghi thủ công'}</p>
          {entry.note && <p className="text-sm savings-entry__note">{entry.note}</p>}
        </div>
        {entry.isMine && !closed && <button type="button" className="btn btn-ghost" aria-label={`Xóa khoản của tôi ngày ${entry.occurredOn}`} onClick={() => { remove.reset(); setDeleting(entry); }}>Xóa</button>}
      </article>)}</div>}
      {detail.isFetchNextPageError && <ErrorState onRetry={() => void detail.fetchNextPage()} />}
      {detail.hasNextPage && <button type="button" className="btn btn-outline btn-block" disabled={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>{detail.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm khoản góp'}</button>}
      {(sheet === 'give' || sheet === 'withdraw') && <SavingsEntrySheet key={sheet} goal={goal} withdraw={sheet === 'withdraw'} onClose={() => setSheet(null)} />}
      {!closed && (sheet === 'update' || sheet === 'close') && <SavingsGoalSheet key={sheet} goal={goal} closeGoal={sheet === 'close'} onClose={() => setSheet(null)} />}
      <BottomSheet open={Boolean(deleting) && !closed} title="Xóa khoản ghi?" onClose={() => { if (!remove.isPending) setDeleting(null); }}>
        <div className="stack"><p>Xóa khoản {deleting ? formatNetVnd(deleting.amountVnd) : ''}? Tổng quỹ sẽ được tính lại. Không thể hoàn tác.</p>{deleting?.source === 'bank' && <p className="text-sm text-muted">Giao dịch ngân hàng này vẫn không thể gắn lại.</p>}{remove.isError && <p className="text-sm text-danger" role="alert">{savingsError(remove.error)}</p>}<button type="button" className="btn btn-primary" disabled={remove.isPending} onClick={removeFromCurrentSession}>Xóa khoản này</button><button type="button" className="btn btn-ghost" disabled={remove.isPending} onClick={() => setDeleting(null)}>Giữ lại</button></div>
      </BottomSheet>
    </>}
  </Page>;
}
