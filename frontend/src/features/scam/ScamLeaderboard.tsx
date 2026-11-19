import { useInfiniteQuery } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { scamApi, scamKey } from './api';

export function ScamLeaderboard({ userId }: { userId: string }) {
  const board = useInfiniteQuery({
    queryKey: [...scamKey(userId), 'board'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => scamApi.board(pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
  });
  return <section className="scam-board" aria-label="Bảng xếp hạng chung">
    <header className="scam-board__header"><span className="scam-board__trophy" aria-hidden="true">🏆</span><div><p className="scam-eyebrow">Ai thuyết phục khéo hơn?</p><h2>Bảng xếp hạng Hội bạn bè</h2></div></header>
    <p className="text-sm text-muted">Xếp theo điểm cao nhất, rồi số ván thắng. Bằng cả hai được đồng hạng. Kết quả cập nhật khi ván kết thúc; nhân vật và tin nhắn luôn riêng tư.</p>
    {board.isPending && <p role="status">Đang tải bảng xếp hạng…</p>}
    {board.isError && <p role="alert">Chưa tải được bảng xếp hạng. <button className="text-link" onClick={() => void (board.isFetchNextPageError ? board.fetchNextPage() : board.refetch())}>Thử lại</button></p>}
    <ol className="scam-board__list">
      {(!board.isError || board.isFetchNextPageError) && board.data?.pages.flatMap(p => p.items).filter((row, index, all) => all.findIndex(r => r.player.id === row.player.id) === index).map(row => <li key={row.player.id} className={`scam-board__row${row.player.id === userId ? ' is-self' : ''}`}>
        <strong className={`scam-board__rank${row.rank <= 3 ? ' is-top' : ''}`}>#{row.rank}</strong><Avatar name={row.player.displayName} src={row.player.avatarUrl} size={36} />
        <span className="scam-board__name">{row.player.displayName}{row.player.id === userId ? ' (bạn)' : ''}</span>
        <span><strong>{row.bestScore}</strong> điểm<br /><small>{row.wins} ván thắng</small></span>
      </li>)}
    </ol>
    {board.isSuccess && !board.data.pages.some(p => p.items.length) && <p>Chưa có kết quả. Hoàn thành hoặc dừng một ván để lên bảng nhé.</p>}
    {board.hasNextPage && <button className="btn btn-outline" disabled={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()}>Xem thêm</button>}
    <button className="text-link" disabled={board.isFetching} onClick={() => void board.refetch()}>Làm mới bảng</button>
  </section>;
}
