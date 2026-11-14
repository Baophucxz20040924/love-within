import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { CoinChip } from '../components/WalletCard';
import { useAuth } from '../features/auth/AuthContext';
import { useApprovals } from '../features/approvals/useApprovals';
import { MARKET_KEY, MARKET_UNREAD_KEY, REDEMPTIONS_KEY, marketApi } from '../features/market/api';
import { ItemFormSheet } from '../features/market/ItemFormSheet';
import { ItemSheet } from '../features/market/ItemSheet';
import { RedemptionCard } from '../features/market/RedemptionCard';
import { formatNumber, shortName } from '../lib/format';
import type { MarketItem, MarketUnread, Redemption } from '../lib/types';

type Tab = 'shop' | 'mine' | 'history';

function ItemTile({ item, onOpen, badge }: { item: MarketItem; onOpen: () => void; badge?: string }) {
  return (
    <button type="button" className="tile" onClick={onOpen}>
      <span className="tile__art" aria-hidden="true">
        {item.emoji}
      </span>
      <span className="tile__title">{item.title}</span>
      <span className="row row--between" style={{ width: '100%', flexWrap: 'wrap', gap: 8 }}>
        <span className="coin-chip" style={{ whiteSpace: 'nowrap' }}>🪙 {formatNumber(item.priceCoin)}</span>
        {badge && <span className="chip chip--brand">{badge}</span>}
      </span>
    </button>
  );
}

export function MarketPage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';
  const [tab, setTab] = useState<Tab>('shop');
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MarketItem | null>(null);

  const items = useQuery({ queryKey: MARKET_KEY, queryFn: marketApi.list });
  const history = useQuery({ queryKey: REDEMPTIONS_KEY, queryFn: marketApi.history, refetchOnWindowFocus: true });
  const { incomingMarket } = useApprovals();

  // Opening the tab clears the "answered requests / new items" badge.
  useEffect(() => {
    marketApi
      .seen()
      .then(() => qc.setQueryData<MarketUnread>(MARKET_UNREAD_KEY, { count: 0, responded: 0, newItems: 0 }))
      .catch(() => undefined);
  }, [qc]);

  const theirs = items.data?.filter((i) => !i.isMine) ?? [];
  const mine = items.data?.filter((i) => i.isMine) ?? [];
  const all = history.data ?? [];
  const myWaiting = all.filter((r) => r.isBuyer && r.status === 'accepted');
  const myRequested = all.filter((r) => r.isBuyer && r.status === 'requested');
  const iOwe = all.filter((r) => !r.isBuyer && r.status === 'accepted');
  const done = all.filter((r) => r.status === 'fulfilled' || r.status === 'declined' || r.status === 'cancelled');
  const openRequestFor = (itemId: string) => myRequested.find((r) => r.itemId === itemId);

  const openForm = (item: MarketItem | null) => {
    setSelected(null);
    setEditing(item);
    setFormOpen(true);
  };

  return (
    <Page title="Chợ" subtitle="Đổi Xu lấy những điều dễ thương" actions={<CoinChip />}>
      <SegmentedControl
        mode="radio"
        ariaLabel="Chợ"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'shop', label: 'Đổi quà' },
          { value: 'mine', label: 'Gian hàng tôi' },
          { value: 'history', label: `Đã đổi${myWaiting.length ? ` (${myWaiting.length})` : ''}` },
        ]}
      />

      {tab === 'shop' && (
        <>
          <p className="text-sm text-muted">
            Gian hàng của <strong>{partnerName}</strong> — những điều {partnerName} sẽ làm cho bạn. Gửi yêu cầu, {partnerName} nhận lời thì món về mục “Đã đổi”.
          </p>
          {items.isLoading && <Skeleton height={190} count={2} />}
          {items.isError && <ErrorState onRetry={() => void items.refetch()} />}
          {items.isSuccess && theirs.length === 0 && (
            <div className="card">
              <EmptyState art="🛍️" title={`${partnerName} chưa đăng món nào`} hint="Nhắc người ấy đăng vài phần thưởng dễ thương nhé 😉" />
            </div>
          )}
          {theirs.length > 0 && (
            <div className="market-grid">
              {theirs.map((it) => (
                <ItemTile key={it.id} item={it} onOpen={() => setSelected(it)} badge={openRequestFor(it.id) ? 'Đang chờ' : undefined} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'mine' && (
        <>
          <p className="text-sm text-muted">Món bạn đăng là phần thưởng bạn sẽ thực hiện cho {partnerName}. Chỉ {partnerName} đổi được.</p>

          {incomingMarket > 0 && (
            <Link to="/approvals" className="attention">
              <span className="icon-tile icon-tile--warning" aria-hidden="true">
                <Icon name="bell" />
              </span>
              <span className="attention__body">
                <span className="attention__title" style={{ display: 'block' }}>
                  {partnerName} muốn đổi {incomingMarket} món
                </span>
                <span className="attention__meta" style={{ display: 'block' }}>
                  Nhận lời hoặc từ chối trong mục Cần duyệt
                </span>
              </span>
              <Icon name="chevronRight" />
            </Link>
          )}

          {iOwe.length > 0 && (
            <div className="section">
              <h2 className="section__title">
                Bạn đang nợ {partnerName} <small>{iOwe.length}</small>
              </h2>
              {iOwe.map((r) => (
                <RedemptionCard key={r.id} r={r} />
              ))}
            </div>
          )}

          {items.isLoading && <Skeleton height={190} count={2} />}
          {items.isError && <ErrorState onRetry={() => void items.refetch()} />}
          {items.isSuccess && (
            <div className="market-grid">
              <button type="button" className="tile tile--add" onClick={() => openForm(null)}>
                <Icon name="plus" size={28} />
                Đăng món mới
              </button>
              {mine.map((it) => (
                <ItemTile key={it.id} item={it} onOpen={() => setSelected(it)} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {history.isLoading && <Skeleton height={96} count={3} />}
          {history.isError && <ErrorState onRetry={() => void history.refetch()} />}
          {history.isSuccess && myWaiting.length === 0 && myRequested.length === 0 && done.length === 0 && (
            <div className="card">
              <EmptyState art="🎁" title="Chưa đổi món nào" hint={`Sang mục “Đổi quà” để chọn một món của ${partnerName}.`} />
            </div>
          )}

          {myWaiting.length > 0 && (
            <div className="section">
              <h2 className="section__title">
                Chờ thực hiện <small>{myWaiting.length}</small>
              </h2>
              {myWaiting.map((r) => (
                <RedemptionCard key={r.id} r={r} />
              ))}
            </div>
          )}

          {myRequested.length > 0 && (
            <div className="section">
              <h2 className="section__title">
                Đang chờ {partnerName} nhận lời <small>{myRequested.length}</small>
              </h2>
              {myRequested.map((r) => (
                <RedemptionCard key={r.id} r={r} />
              ))}
            </div>
          )}

          {done.length > 0 && (
            <div className="section">
              <h2 className="section__title">Lịch sử</h2>
              {done.map((r: Redemption) => (
                <RedemptionCard key={r.id} r={r} />
              ))}
            </div>
          )}
        </>
      )}

      <ItemSheet item={selected} onClose={() => setSelected(null)} onEdit={openForm} onRequested={() => setTab('history')} />
      <ItemFormSheet open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
    </Page>
  );
}
