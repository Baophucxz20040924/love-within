import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { WALLET_KEY } from '../quests/api';
import { ApiRequestError } from '../../lib/apiClient';
import { formatNumber, shortName, timeAgo } from '../../lib/format';
import type { Redemption, RedemptionStatus } from '../../lib/types';
import { MARKET_PENDING_KEY, REDEMPTIONS_KEY, marketApi } from './api';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

const STATUS: Record<RedemptionStatus, { label: string; chip: string }> = {
  refunding: { label: 'Đang hoàn Xu cho người mua', chip: 'chip--warning' },
  requested: { label: 'Chờ nhận lời', chip: 'chip--warning' },
  accepted: { label: 'Chờ thực hiện', chip: 'chip--brand' },
  fulfilled: { label: 'Đã thực hiện', chip: 'chip--success' },
  declined: { label: 'Đã từ chối', chip: 'chip--danger' },
  cancelled: { label: 'Đã rút lại', chip: '' },
};

/** One row in "Đã đổi". Buyer can withdraw a pending request and confirm a delivered reward. */
export function RedemptionCard({ r }: { r: Redemption }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: REDEMPTIONS_KEY }),
      qc.invalidateQueries({ queryKey: MARKET_PENDING_KEY }),
      qc.invalidateQueries({ queryKey: WALLET_KEY }),
    ]);
    await refreshMe();
  };
  const fulfill = useMutation({
    mutationFn: () => marketApi.fulfill(r.id),
    onSuccess: async () => {
      toast.success(`Tuyệt! "${r.itemTitle}" đã hoàn thành 🎉`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const cancel = useMutation({
    mutationFn: () => marketApi.cancel(r.id),
    onSuccess: async () => {
      toast.info(`Đã rút lại. ${formatNumber(r.priceCoin)} Xu hoàn về ví của bạn.`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const s = STATUS[r.status];
  const who = r.isBuyer ? 'Bạn' : shortName(r.buyerName);
  const when = r.fulfilledAt ?? r.respondedAt ?? r.createdAt;
  const refunded = r.status === 'declined' || r.status === 'cancelled';

  return (
    <article className="card redemption">
      <div className="row">
        <span className="icon-tile icon-tile--neutral" style={{ fontSize: 24 }} aria-hidden="true">
          {r.itemEmoji}
        </span>
        <div className="grow" style={{ flex: 1, minWidth: 0 }}>
          <p className="strong" style={{ lineHeight: 1.3 }}>
            {r.itemTitle}
          </p>
          <p className="text-sm text-muted">
            {who} đổi · {timeAgo(when)}
          </p>
          <p className={`text-sm num ${refunded ? 'text-muted' : 'strong'}`}>
            {refunded ? `Đã hoàn ${formatNumber(r.priceCoin)} Xu` : `−${formatNumber(r.priceCoin)} Xu`}
          </p>
        </div>
        <span className={`chip ${s.chip}`}>{s.label}</span>
      </div>

      {r.responseNote && (
        <p className="redemption__note">
          <Icon name="messageCircle" size={14} /> {shortName(r.sellerName)}: “{r.responseNote}”
        </p>
      )}

      {r.status === 'accepted' && r.isBuyer && (
        <div className="redemption__actions">
          <p className="text-sm text-muted">{partnerName} đã nhận lời. Khi đã nhận được phần thưởng, bấm xác nhận nhé.</p>
          <button type="button" className="btn btn-primary btn-block" disabled={fulfill.isPending} onClick={() => fulfill.mutate()}>
            <Icon name="check" size={18} /> Đã thực hiện
          </button>
        </div>
      )}
      {r.status === 'accepted' && !r.isBuyer && (
        <p className="text-sm text-muted">Bạn đã nhận lời — {shortName(r.buyerName)} sẽ đánh dấu khi bạn thực hiện xong.</p>
      )}
      {r.status === 'requested' && r.isBuyer && (
        <div className="row row--between">
          <span className="text-sm text-muted">Chờ {partnerName} trả lời</span>
          <button type="button" className="btn btn-ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            <Icon name="undo" size={16} /> Rút lại
          </button>
        </div>
      )}
    </article>
  );
}
