import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import {
  FINANCE_CONNECTION_KEY,
  financeApi,
  financeOwnerKey,
  financeSummaryKey,
  lastErrorText,
  retryUnlessAnswer,
  type FinanceOwner,
} from '../features/finance/api';
import { useBankSync } from '../features/finance/FinanceSettings';
import { FINANCE_GUIDE_PATH } from '../features/finance/FinanceGuide';
import { ASSISTANT_PATH } from '../features/finance/assistantApi';
import { MonthNav, SummaryCard, TxnFeed } from '../features/finance/FinanceViews';
import { LinkBankWizard } from '../features/finance/LinkBankWizard';
import { NoteSheet } from '../features/finance/NoteSheet';
import { ApiRequestError } from '../lib/apiClient';
import { localDateOf, shortName, timeAgo } from '../lib/format';
import type { BankTxn, FinanceConnection } from '../lib/types';

function MineView({ conn, month, today, onLink }: { conn: FinanceConnection; month: string; today: string; onLink: () => void }) {
  const [noteTxn, setNoteTxn] = useState<BankTxn | null>(null);
  const sync = useBankSync();
  const summary = useQuery({
    queryKey: financeSummaryKey('mine', month),
    queryFn: () => financeApi.summary('mine', month),
    refetchInterval: 60_000,
  });

  if (conn.status === null) {
    return (
      <div className="card">
        <EmptyState
          art="💳"
          title="Theo dõi dòng tiền của bạn"
          hint="Liên kết MBBank qua thueapibank.vn để app tự ghi tiền vào / ra. Mặc định chỉ mình bạn xem."
          action={
            <div className="stack" style={{ alignItems: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={onLink}>
                <Icon name="creditCard" size={18} /> Liên kết ngân hàng
              </button>
              <Link to={FINANCE_GUIDE_PATH} className="text-link">
                Xem hướng dẫn liên kết
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <>
      {conn.status === 'error' && (
        <div className="attention" role="alert">
          <span className="icon-tile icon-tile--warning" aria-hidden="true">
            <Icon name="alert" />
          </span>
          <span className="attention__body">
            <span className="attention__title" style={{ display: 'block' }}>
              Mất kết nối ngân hàng
            </span>
            <span className="attention__meta attention__meta--wrap" style={{ display: 'block' }}>
              {lastErrorText(conn.lastError)}. Kiểm tra gói trên thueapibank.vn còn hạn rồi thử lại. Nếu token đã đổi, hãy
              ngắt kết nối (giữ lịch sử) rồi liên kết lại trong Hồ sơ.
            </span>
          </span>
          <button type="button" className="btn btn-outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
            Thử lại
          </button>
        </div>
      )}
      {conn.status === 'revoked' && (
        <button type="button" className="attention" onClick={onLink}>
          <span className="icon-tile icon-tile--warning" aria-hidden="true">
            <Icon name="creditCard" />
          </span>
          <span className="attention__body">
            <span className="attention__title" style={{ display: 'block' }}>
              Đã ngắt kết nối ngân hàng
            </span>
            <span className="attention__meta attention__meta--wrap" style={{ display: 'block' }}>
              Lịch sử cũ vẫn còn. Chạm để liên kết lại.
            </span>
          </span>
          <Icon name="chevronRight" />
        </button>
      )}

      {summary.isLoading && <Skeleton height={104} />}
      {summary.isError && <ErrorState onRetry={() => void summary.refetch()} />}
      {summary.data && <SummaryCard summary={summary.data} />}

      <Link to={ASSISTANT_PATH} className="attention attention--brand">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="messageCircle" />
        </span>
        <span className="attention__body">
          <span className="attention__title" style={{ display: 'block' }}>
            Trợ lý chi tiêu AI
          </span>
          <span className="attention__meta attention__meta--wrap" style={{ display: 'block' }}>
            Phân tích tháng trước và tháng này, gợi ý chi tiêu, hỏi đáp
          </span>
        </span>
        <Icon name="chevronRight" />
      </Link>

      <TxnFeed
        owner="mine"
        month={month}
        today={today}
        onSelect={setNoteTxn}
        emptyHint={conn.linked ? 'Giao dịch mới tự xuất hiện sau khoảng 2 phút.' : 'Liên kết lại để cập nhật giao dịch mới.'}
      />
      {conn.linked && conn.lastSuccessAt && (
        <p className="text-sm text-muted center">
          MBBank ••{conn.accountLast4} · cập nhật {timeAgo(conn.lastSuccessAt)}
        </p>
      )}
      <NoteSheet txn={noteTxn} onClose={() => setNoteTxn(null)} />
    </>
  );
}

function PartnerView({ month, today, partnerName }: { month: string; today: string; partnerName: string }) {
  // The summary call doubles as the permission check: the feed only loads once it succeeds.
  const summary = useQuery({
    queryKey: financeSummaryKey('partner', month),
    queryFn: () => financeApi.summary('partner', month),
    retry: retryUnlessAnswer,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  if (summary.isPending) return <Skeleton height={104} />;
  if (summary.isError) {
    const code = summary.error instanceof ApiRequestError ? summary.error.code : '';
    if (code === 'FINANCE_PRIVATE') {
      return (
        <div className="card">
          <EmptyState
            art="🔒"
            title={`${partnerName} đang để riêng tư`}
            hint={`Khi ${partnerName} bật chia sẻ dòng tiền trong Hồ sơ, giao dịch sẽ hiện ở đây.`}
          />
        </div>
      );
    }
    if (code === 'FINANCE_NOT_LINKED') {
      return (
        <div className="card">
          <EmptyState
            art="💳"
            title={`${partnerName} chưa liên kết ngân hàng`}
            hint={`Mỗi người tự liên kết tài khoản của mình. ${partnerName} làm theo hướng dẫn rồi bật chia sẻ trong Hồ sơ là bạn xem được.`}
            action={
              <Link to={FINANCE_GUIDE_PATH} className="btn btn-outline">
                <Icon name="helpCircle" size={18} /> Hướng dẫn liên kết
              </Link>
            }
          />
        </div>
      );
    }
    return <ErrorState onRetry={() => void summary.refetch()} />;
  }

  return (
    <>
      <SummaryCard summary={summary.data} />
      <TxnFeed owner="partner" month={month} today={today} emptyHint={`${partnerName} chưa có giao dịch nào trong tháng này.`} />
      <p className="text-sm text-muted center">Chỉ {partnerName} sửa được ghi chú của mình.</p>
    </>
  );
}

export function FinancePage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const tz = me?.user.timezone ?? 'Asia/Ho_Chi_Minh';
  const today = localDateOf(new Date(), tz);
  const thisMonth = today.slice(0, 7);
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'Người ấy';

  const [owner, setOwner] = useState<FinanceOwner>('mine');
  const [month, setMonth] = useState(thisMonth);
  const [wizardOpen, setWizardOpen] = useState(false);
  const conn = useQuery({ queryKey: FINANCE_CONNECTION_KEY, queryFn: financeApi.connection });

  // Opening the page asks the server to poll the bank now (it reuses a poll younger than 60 s).
  const synced = useRef(false);
  const linked = conn.data?.linked ?? false;
  useEffect(() => {
    if (!linked || synced.current) return;
    synced.current = true;
    financeApi
      .sync()
      .then((r) => {
        qc.setQueryData(FINANCE_CONNECTION_KEY, r.connection);
        if (r.inserted > 0) void qc.invalidateQueries({ queryKey: financeOwnerKey('mine') });
      })
      .catch(() => undefined);
  }, [linked, qc]);

  return (
    <Page
      title="Dòng tiền"
      subtitle="Tiền vào / ra từ tài khoản ngân hàng"
      back="/"
      actions={
        <Link to={FINANCE_GUIDE_PATH} className="icon-btn" aria-label="Hướng dẫn liên kết">
          <Icon name="helpCircle" />
        </Link>
      }
    >
      <Link to="/savings" className="card card--link">
        <div className="row">
          <span className="icon-tile" aria-hidden="true"><Icon name="creditCard" /></span>
          <div className="grow"><p className="card__title">Quỹ chung</p><p className="text-sm text-muted">Cùng góp cho mục tiêu · không cần liên kết ngân hàng</p></div>
          <Icon name="chevronRight" />
        </div>
      </Link>
      <SegmentedControl
        mode="radio"
        ariaLabel="Xem dòng tiền của"
        value={owner}
        onChange={setOwner}
        options={[
          { value: 'mine', label: 'Của tôi' },
          { value: 'partner', label: `Của ${partnerName}` },
        ]}
      />
      <MonthNav month={month} max={thisMonth} onChange={setMonth} />

      {owner === 'mine' && (
        <>
          {conn.isLoading && <Skeleton height={104} count={2} />}
          {conn.isError && <ErrorState onRetry={() => void conn.refetch()} />}
          {conn.data && <MineView conn={conn.data} month={month} today={today} onLink={() => setWizardOpen(true)} />}
          {conn.data && (
            <p className="text-sm text-muted center">
              {conn.data.visibility === 'partner' ? `${partnerName} đang xem được dòng tiền của bạn. ` : 'Chỉ mình bạn xem dòng tiền này. '}
              <Link to="/profile" className="text-link">
                Đổi trong Hồ sơ
              </Link>
            </p>
          )}
        </>
      )}
      {owner === 'partner' && <PartnerView month={month} today={today} partnerName={partnerName} />}

      <LinkBankWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </Page>
  );
}
