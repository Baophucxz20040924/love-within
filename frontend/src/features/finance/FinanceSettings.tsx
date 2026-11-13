import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/StatusViews';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatNumber, timeAgo } from '../../lib/format';
import type { FinanceConnection, FinanceVisibility } from '../../lib/types';
import { FINANCE_CONNECTION_KEY, FINANCE_KEY, THUEAPIBANK_URL, financeApi, financeOwnerKey, lastErrorText } from './api';
import { LinkBankWizard } from './LinkBankWizard';
import { FINANCE_GUIDE_PATH } from './FinanceGuide';

const errMsg = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** Retry a connection in 'error' / refresh now. Shared by the settings list and the finance page banner. */
export function useBankSync() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: financeApi.sync,
    onSuccess: async (r) => {
      qc.setQueryData(FINANCE_CONNECTION_KEY, r.connection);
      if (r.error) toast.error(`Chưa đồng bộ được: ${r.error.message}`);
      else toast.success(r.inserted > 0 ? `Có ${formatNumber(r.inserted)} giao dịch mới` : 'Đã cập nhật, không có giao dịch mới');
      await qc.invalidateQueries({ queryKey: ['finance', 'mine'] });
    },
    onError: (err) => toast.error(errMsg(err)),
  });
}

/** Disconnect: always drops the token; optionally deletes the stored history too. */
function DisconnectSheet({ open, onClose, linked }: { open: boolean; onClose: () => void; linked: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const disconnect = useMutation({
    mutationFn: (purge: boolean) => financeApi.disconnect(purge),
    onSuccess: async (r, purge) => {
      qc.setQueryData(FINANCE_CONNECTION_KEY, r.connection);
      // Deleted data must not flash back from the cache when the finance page opens again.
      if (purge) qc.removeQueries({ queryKey: financeOwnerKey('mine') });
      toast.success(purge ? `Đã xóa ${formatNumber(r.deleted)} giao dịch` : 'Đã ngắt kết nối, lịch sử vẫn được giữ');
      onClose();
      await qc.invalidateQueries({ queryKey: FINANCE_KEY });
    },
    onError: (err) => toast.error(errMsg(err)),
  });

  return (
    <BottomSheet open={open} onClose={onClose} title={linked ? 'Ngắt kết nối ngân hàng' : 'Xóa lịch sử giao dịch'}>
      <div className="form">
        {linked && <p className="text-muted">App sẽ xóa token và ngừng cập nhật giao dịch mới.</p>}
        <p className="callout">
          <Icon name="alert" size={18} />
          <span>
            Ngắt ở app <strong>không</strong> xóa tài khoản MB trên thueapibank. Muốn bot của họ dừng đăng nhập MB, vào{' '}
            <a href={`${THUEAPIBANK_URL}/home/mbbank`} target="_blank" rel="noopener noreferrer" className="text-link">
              thueapibank.vn → MBBank
            </a>{' '}
            và xóa tài khoản ở đó.
          </span>
        </p>
        {linked && (
          <button type="button" className="btn btn-outline btn-lg btn-block" disabled={disconnect.isPending} onClick={() => disconnect.mutate(false)}>
            Ngắt kết nối, giữ lịch sử
          </button>
        )}
        <button type="button" className="btn btn-danger btn-lg btn-block" disabled={disconnect.isPending} onClick={() => disconnect.mutate(true)}>
          {linked ? 'Ngắt và xóa toàn bộ giao dịch' : 'Xóa toàn bộ giao dịch đã lưu'}
        </button>
        <p className="text-sm text-muted center">Không thể hoàn tác việc xóa giao dịch và ghi chú.</p>
      </div>
    </BottomSheet>
  );
}

function statusMeta(c: FinanceConnection): { text: string; danger: boolean } {
  if (c.status === 'error') return { text: `Mất kết nối · ${lastErrorText(c.lastError)}`, danger: true };
  return { text: c.lastSuccessAt ? `Cập nhật ${timeAgo(c.lastSuccessAt)}` : 'Đang chờ đồng bộ', danger: false };
}

/** Profile → "Dòng tiền": link status, "Cho người ấy xem", sync, disconnect. */
export function FinanceSettings({ partnerName }: { partnerName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const conn = useQuery({ queryKey: FINANCE_CONNECTION_KEY, queryFn: financeApi.connection });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const sync = useBankSync();

  const visibility = useMutation({
    mutationFn: (v: FinanceVisibility) => financeApi.setVisibility(v),
    onSuccess: (r) => {
      qc.setQueryData<FinanceConnection>(FINANCE_CONNECTION_KEY, (old) => (old ? { ...old, visibility: r.visibility } : old));
      toast.success(r.visibility === 'partner' ? `${partnerName} đã xem được dòng tiền của bạn` : 'Đã chuyển về chỉ mình bạn xem');
    },
    onError: (err) => toast.error(errMsg(err)),
  });

  const c = conn.data;
  const shared = (visibility.isPending ? visibility.variables : c?.visibility) === 'partner';

  return (
    <div className="section">
      <h2 className="section__title">Dòng tiền</h2>
      {conn.isLoading && <Skeleton height={56} count={2} />}
      {c && (
        <div className="list">
          {c.linked ? (
            <Link to="/finance" className="list__item">
              <span className={`icon-tile${c.status === 'error' ? ' icon-tile--warning' : ' icon-tile--success'}`} aria-hidden="true">
                <Icon name="creditCard" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">MBBank ••{c.accountLast4}</span>
                <span className={`list__meta${statusMeta(c).danger ? ' text-danger' : ''}`} style={{ display: 'block' }}>
                  {statusMeta(c).text}
                </span>
              </span>
              <Icon name="chevronRight" className="text-muted" />
            </Link>
          ) : (
            <button type="button" className="list__item" onClick={() => setWizardOpen(true)}>
              <span className="icon-tile" aria-hidden="true">
                <Icon name="creditCard" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">{c.status === 'revoked' ? 'Liên kết lại ngân hàng' : 'Liên kết ngân hàng'}</span>
                <span className="list__meta" style={{ display: 'block' }}>
                  MBBank qua thueapibank.vn, tự ghi tiền vào / ra
                </span>
              </span>
              <Icon name="chevronRight" className="text-muted" />
            </button>
          )}

          <label className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name={shared ? 'eye' : 'lock'} size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Cho {partnerName} xem</span>
              <span className="list__meta" style={{ display: 'block' }}>
                {shared ? `${partnerName} xem được giao dịch và ghi chú` : 'Chỉ mình bạn xem'}
              </span>
            </span>
            <Switch checked={shared} disabled={visibility.isPending} onChange={(on) => visibility.mutate(on ? 'partner' : 'private')} />
          </label>

          {c.linked && (
            <button type="button" className="list__item" disabled={sync.isPending} onClick={() => sync.mutate()}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="refresh" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">{c.status === 'error' ? 'Thử kết nối lại' : 'Đồng bộ ngay'}</span>
              </span>
              {sync.isPending && <span className="spinner" aria-label="Đang đồng bộ" />}
            </button>
          )}

          {(c.linked || c.status === 'revoked') && (
            <button type="button" className="list__item" onClick={() => setDisconnectOpen(true)}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="trash" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label text-danger">{c.linked ? 'Ngắt kết nối ngân hàng' : 'Xóa lịch sử giao dịch'}</span>
              </span>
            </button>
          )}

          <Link to={FINANCE_GUIDE_PATH} className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="helpCircle" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Hướng dẫn liên kết</span>
              <span className="list__meta" style={{ display: 'block' }}>
                Các bước cho mỗi người và câu hỏi thường gặp
              </span>
            </span>
            <Icon name="chevronRight" className="text-muted" />
          </Link>
        </div>
      )}

      <LinkBankWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onLinked={() => navigate('/finance')} />
      <DisconnectSheet open={disconnectOpen} onClose={() => setDisconnectOpen(false)} linked={!!c?.linked} />
    </div>
  );
}
