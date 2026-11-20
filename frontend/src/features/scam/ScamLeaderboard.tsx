import { useInfiniteQuery } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { scamApi, scamKey } from './api';
import { ApiRequestError } from '../../lib/apiClient';

function boardError(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Chưa tải được bảng xếp hạng. Kiểm tra kết nối rồi thử lại nhé.';
  if (error.status === 401 || error.status === 403) return 'Cần xác minh lại quyền truy cập để xem bảng bạn bè.';
  if (error.status === 429) return 'Bạn đang tải quá nhanh. Đợi một chút rồi thử lại nhé.';
  if (error.code === 'SCAM_BOARD_TIMEOUT') return 'Bảng xếp hạng đang phản hồi chậm. Thử lại sau nhé.';
  return 'Chưa tải được bảng xếp hạng. Thử lại sau nhé.';
}

export function ScamLeaderboard({ userId }: { userId: string }) {
  const board = useInfiniteQuery({
    queryKey: [...scamKey(userId), 'board', 'friends-v2'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => scamApi.board(pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
  });
  const reference = board.error instanceof ApiRequestError ? board.error.requestId : undefined;
  return <section className="scam-board" aria-label="Bảng xếp hạng bạn bè">
    <header className="scam-board__header"><span className="scam-board__trophy" aria-hidden="true">🏆</span><div><p className="scam-eyebrow">Ai thuyết phục khéo hơn?</p><h2>Bảng xếp hạng bạn bè</h2></div></header>
    <p className="text-sm text-muted">Chỉ gồm bạn và những người đã kết bạn. Xếp theo tổng tiền giả lập cao nhất trong một ván (gồm bonus), rồi số ván thắng; bằng cả hai được đồng hạng. Kết quả cập nhật khi ván kết thúc; nhân vật và tin nhắn luôn riêng tư.</p>
    {board.isPending && <p role="status">Đang tải bảng xếp hạng…</p>}
    {board.isError && <p role="alert">{boardError(board.error)} {reference && <small>Mã tham chiếu: {reference}. </small>}<button className="text-link" onClick={() => void (board.isFetchNextPageError ? board.fetchNextPage() : board.refetch())}>Thử lại</button></p>}
    <ol className="scam-board__list">
      {(!board.isError || board.isFetchNextPageError) && board.data?.pages.flatMap(p => p.items).filter((row, index, all) => all.findIndex(r => r.player.id === row.player.id) === index).map(row => <li key={row.player.id} className={`scam-board__row${row.player.id === userId ? ' is-self' : ''}`}>
        <strong className={`scam-board__rank${row.rank <= 3 ? ' is-top' : ''}`}>#{row.rank}</strong><Avatar name={row.player.displayName} src={row.player.avatarUrl} size={36} />
        <span className="scam-board__name">{row.player.displayName}{row.player.id === userId ? ' (bạn)' : ''}</span>
        <span><strong>{row.bestScore}$</strong><br /><small>{row.wins} ván thắng</small></span>
      </li>)}
    </ol>
    {board.isSuccess && !board.hasNextPage && !board.data.pages.some(p => p.items.length) && <p>Bạn và bạn bè chưa có ván đã kết thúc. Hoàn thành hoặc dừng một ván để lên bảng nhé.</p>}
    {board.hasNextPage && <button className="btn btn-outline" disabled={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()}>Xem thêm</button>}
    <button className="text-link" disabled={board.isFetching} onClick={() => void board.refetch()}>Làm mới bảng</button>
  </section>;
}
