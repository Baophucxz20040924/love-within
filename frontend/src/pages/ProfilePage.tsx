import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { WalletCard } from '../components/WalletCard';
import { useAuth } from '../features/auth/AuthContext';
import { FinanceSettings } from '../features/finance/FinanceSettings';
import { AvatarSheet } from '../features/profile/AvatarSheet';
import { PROPOSAL_KEY, proposalsApi } from '../features/proposals/api';
import { LEDGER_KEY, walletApi } from '../features/quests/api';
import { WATER_KEY, waterApi } from '../features/water/api';
import { ApiRequestError } from '../lib/apiClient';
import { formatDate, formatDay, formatMl, formatNumber, shortName, timeAgo } from '../lib/format';
import type { LedgerEntry } from '../lib/types';
import { isStandalone } from '../lib/installPrompt';

const REASON: Record<string, string> = {
  checkin: 'Điểm danh',
  moment: 'Khoảnh khắc',
  quest: 'Nhiệm vụ',
  market_purchase: 'Đổi hàng',
  market_refund: 'Hoàn Xu',
  bucket_list: 'Bucket list',
  admin: 'Hệ thống',
};

function AnniversarySheet({ open, onClose, current }: { open: boolean; onClose: () => void; current: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState('');

  useEffect(() => {
    if (open) setDate(current ? current.slice(0, 10) : '');
  }, [open, current]);

  const propose = useMutation({
    mutationFn: () => proposalsApi.proposeAnniversary(date),
    onSuccess: async () => {
      toast.success('Đã gửi đề xuất. Chờ người yêu đồng ý.');
      onClose();
      await qc.invalidateQueries({ queryKey: PROPOSAL_KEY });
    },
  });

  useEffect(() => {
    if (open && propose.isError) propose.reset();
  }, [open, propose.reset]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    propose.mutate();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Ngày bắt đầu yêu">
      <form className="form" onSubmit={onSubmit}>
        <p className="text-muted">Thay đổi chỉ được áp dụng khi cả hai cùng đồng ý.</p>
        <label className="field">
          <span className="field__label">Ngày</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} required />
        </label>
        {propose.isError && <p className="form-feedback" role="alert">{propose.error instanceof ApiRequestError ? propose.error.message : 'Có lỗi xảy ra'}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!date || propose.isPending}>
          Gửi đề xuất
        </button>
      </form>
    </BottomSheet>
  );
}

const REWARD_COMPONENT: Record<NonNullable<LedgerEntry['provenance']>['component'], string> = {
  checkin_pair: 'Điểm danh đủ đôi · Xu của bạn',
  checkin_exp: 'Điểm danh cá nhân · EXP',
  photo_base: 'Khoảnh khắc · ảnh đầu ngày',
  timely_pair_bonus: 'Khoảnh khắc · đủ đôi đúng giờ',
  quest_exp: 'Nhiệm vụ · EXP chung',
};

export function LedgerRewardDetail({ entry }: { entry: LedgerEntry }) {
  const p = entry.provenance;
  if (!p) return null;
  return <p className="list__meta">
    Ngày thưởng {formatDay(p.localDate)} · Chính sách v{p.policyVersion}
    {entry.type === 'coin' && <> · {formatNumber(p.baseCoin)} cơ bản + {formatNumber(p.bonusCoin)} thưởng{p.component === 'checkin_pair' ? ' chuỗi' : p.component === 'timely_pair_bonus' ? ' đủ đôi' : ''}</>}
    {p.commonStreak != null && <> · Chuỗi chung {formatNumber(p.commonStreak)} ngày</>}
  </p>;
}

export function LedgerRow({ entry: e }: { entry: LedgerEntry }) {
  return <div className="list__item">
    <div className="list__body">
      <p className="list__label">{(e.provenance && REWARD_COMPONENT[e.provenance.component]) || REASON[e.reason] || e.reason}</p>
      <p className="list__meta">{e.scope === 'legacy_shared' ? 'Ví chung trước chuyển đổi' : e.scope === 'shared_exp' ? 'EXP chung' : 'Ví Xu của bạn'} · {timeAgo(e.createdAt)}</p>
      <LedgerRewardDetail entry={e} />
    </div>
    <span className={`strong num${e.delta < 0 ? ' text-danger' : ''}`}>
      {e.delta > 0 ? '+' : e.delta < 0 ? '−' : ''}{formatNumber(Math.abs(e.delta))} {e.type === 'coin' ? 'Xu' : 'EXP'}
    </span>
  </div>;
}

export function Ledger({ scope }: { scope: string }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const historical = cursors.length > 1;
  const ledger = useQuery({
    queryKey: [...LEDGER_KEY, 'page', scope, cursor ?? null],
    queryFn: ({ signal }) => walletApi.ledgerPage(cursor, undefined, signal),
  });
  return (
    <div className="stack">
      <p className="text-sm text-muted">Mỗi dòng là số Xu hoặc EXP thực nhận. Giao dịch cũ giữ nguyên số đã ghi, không suy thành tổng thưởng của hai người.</p>
      {historical && <p className="text-sm text-muted">Đang xem lịch sử cũ.</p>}
      {ledger.isLoading ? <Skeleton height={56} count={3} /> : ledger.isError ? <ErrorState onRetry={() => ledger.refetch()} /> : !ledger.data?.items.length ? (
        <EmptyState art="🪙" title={historical ? 'Trang này không còn giao dịch' : 'Chưa có giao dịch'} hint={historical ? 'Quay về trang mới hơn để tiếp tục.' : 'Điểm danh và làm nhiệm vụ để nhận Xu.'} />
      ) : <div className="list">{ledger.data.items.map((e) => <LedgerRow key={e.id} entry={e} />)}</div>}
      <nav className="row wrap" aria-label="Phân trang lịch sử ví">
        <button type="button" className="btn btn-ghost" disabled={!historical} onClick={() => setCursors((all) => all.slice(0, -1))}>Mới hơn</button>
        <button type="button" className="btn btn-ghost" disabled={ledger.isFetching || ledger.isError || !ledger.data?.nextCursor} onClick={() => {
          if (ledger.data?.nextCursor) setCursors((all) => [...all, ledger.data.nextCursor!]);
        }}>Cũ hơn</button>
        {historical && <button type="button" className="btn btn-ghost" onClick={() => setCursors([undefined])}>Mới nhất</button>}
      </nav>
    </div>
  );
}

export function ProfilePage() {
  const { me, logout } = useAuth();
  const couple = me?.couple;
  const partner = couple?.members.find((m) => m.id !== me?.user.id);
  const water = useQuery({ queryKey: WATER_KEY, queryFn: waterApi.today });
  const [annOpen, setAnnOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  return (
    <Page title="Hồ sơ">
      {me && couple && (
        <div className="card couple-card">
          <span className="avatar-pair">
            <button type="button" className="avatar-button" aria-label="Đổi ảnh đại diện" onClick={() => setAvatarOpen(true)}>
              <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={52} ring />
            </button>
            {partner && <Avatar name={partner.displayName} src={partner.avatarUrl} size={52} ring />}
          </span>
          <div style={{ minWidth: 0 }}>
            <p className="card__title">
              {shortName(me.user.displayName)} & {partner ? shortName(partner.displayName) : '…'}
            </p>
            <p className="text-sm text-muted">
              {formatNumber(couple.daysInLove ?? 0)} ngày bên nhau · Cấp {couple.level}
            </p>
          </div>
        </div>
      )}

      <WalletCard />

      <div className="section">
        <h2 className="section__title">Couple</h2>
        <div className="list">
          <button type="button" className="list__item" onClick={() => setAnnOpen(true)}>
            <span className="icon-tile" aria-hidden="true">
              <Icon name="calendar" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Ngày bắt đầu yêu</span>
            </span>
            <span className="list__value">
              {couple?.anniversaryDate ? formatDate(couple.anniversaryDate, couple.timezone) : 'Chưa đặt'}
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </button>
          <Link to="/events" className="list__item">
            <span className="icon-tile" aria-hidden="true">
              <Icon name="gift" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Sự kiện sắp tới</span>
              <span className="list__meta" style={{ display: 'block' }}>
                Sinh nhật, chuyến đi, ngày gặp nhau
              </span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
          <Link to="/profile/moods" className="list__item">
            <span className="icon-tile" aria-hidden="true">
              <Icon name="smile" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Cảm xúc 30 ngày</span>
              <span className="list__meta" style={{ display: 'block' }}>
                Cảm xúc mỗi ngày của hai bạn
              </span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
          <Link to="/quests/water" className="list__item">
            <span className="icon-tile icon-tile--water" aria-hidden="true">
              <Icon name="droplet" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Mục tiêu nước</span>
            </span>
            <span className="list__value">{water.data?.goalMl ? formatMl(water.data.goalMl) : 'Chưa đặt'}</span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
          <div className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="globe" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Múi giờ</span>
            </span>
            <span className="list__value">{couple?.timezone}</span>
          </div>
        </div>
      </div>

      <FinanceSettings partnerName={partner ? shortName(partner.displayName) : 'người ấy'} />

      <div className="section">
        <h2 className="section__title">
          Lịch sử Xu / EXP
          <button type="button" className="btn btn-ghost" onClick={() => setShowLedger((v) => !v)}>
            {showLedger ? 'Ẩn' : 'Xem'}
          </button>
        </h2>
        {showLedger && me && couple && <Ledger key={`${me.user.id}:${couple.id}`} scope={`${me.user.id}:${couple.id}`} />}
      </div>

      <div className="section">
        <h2 className="section__title">Tài khoản</h2>
        <div className="list">
          <button type="button" className="list__item" onClick={() => setAvatarOpen(true)}>
            <Avatar name={me?.user.displayName ?? ''} src={me?.user.avatarUrl} size={44} />
            <span className="list__body">
              <span className="list__label">Ảnh đại diện</span>
              <span className="list__meta" style={{ display: 'block' }}>
                {me?.user.avatarUrl ? 'Chạm để đổi hoặc gỡ ảnh' : 'Thêm ảnh để người ấy thấy bạn'}
              </span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </button>
          <Link to="/profile/app-lock" className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true"><Icon name="shield" size={20} /></span>
            <span className="list__body"><span className="list__label">Mã khóa ứng dụng</span><span className="list__meta" style={{ display: 'block' }}>Mã 6 số khi mở lại ứng dụng</span></span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
          <Link to="/profile/notifications" className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="bell" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Thông báo</span>
              <span className="list__meta" style={{ display: 'block' }}>
                Báo ra màn hình khóa, giờ yên lặng
              </span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
          <div className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="mail" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">{me?.user.displayName}</span>
              <span className="list__meta" style={{ display: 'block' }}>
                {me?.user.email}
              </span>
            </span>
          </div>
          {!isStandalone() && (
            <Link to="/install" className="list__item">
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="smartphone" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Cài app lên điện thoại</span>
                <span className="list__meta" style={{ display: 'block' }}>
                  Mở nhanh từ màn hình chính
                </span>
              </span>
              <Icon name="chevronRight" className="text-muted" />
            </Link>
          )}
          <button type="button" className="list__item" onClick={logout}>
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="logOut" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Đăng xuất</span>
            </span>
          </button>
        </div>
      </div>

      <AnniversarySheet open={annOpen} onClose={() => setAnnOpen(false)} current={couple?.anniversaryDate ?? null} />
      <AvatarSheet open={avatarOpen} onClose={() => setAvatarOpen(false)} hint="Người ấy sẽ thấy ảnh này. Ảnh dùng chung cho tài khoản của bạn." />
    </Page>
  );
}
