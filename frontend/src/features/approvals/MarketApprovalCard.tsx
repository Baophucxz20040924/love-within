import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useAvatarOf } from '../auth/useAvatarOf';
import { WALLET_KEY } from '../quests/api';
import { MARKET_KEY, MARKET_PENDING_KEY, REDEMPTIONS_KEY, marketApi } from '../market/api';
import { ApiRequestError } from '../../lib/apiClient';
import { formatNumber, shortName, timeAgo } from '../../lib/format';
import type { Redemption } from '../../lib/types';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

interface Props {
  item: Redemption;
  /** incoming = partner wants one of MY rewards (I answer); outgoing = my request, waiting for the partner. */
  mode: 'incoming' | 'outgoing';
}

/** "Bob muốn đổi Massage 15 phút" — the seller accepts or declines (with an optional note). */
export function MarketApprovalCard({ item, mode }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const avatarOf = useAvatarOf();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: MARKET_PENDING_KEY }),
      qc.invalidateQueries({ queryKey: REDEMPTIONS_KEY }),
      qc.invalidateQueries({ queryKey: MARKET_KEY }),
      qc.invalidateQueries({ queryKey: WALLET_KEY }),
    ]);
    await refreshMe();
  };

  const accept = useMutation({
    mutationFn: () => marketApi.accept(item.id),
    onSuccess: async () => {
      toast.success(`Đã nhận lời! "${item.itemTitle}" chuyển sang chờ bạn thực hiện 💪`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const decline = useMutation({
    mutationFn: () => marketApi.decline(item.id, note.trim() || undefined),
    onSuccess: async () => {
      setDeclining(false);
      toast.info(`Đã từ chối. ${formatNumber(item.priceCoin)} Xu được hoàn lại ví chung.`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const cancel = useMutation({
    mutationFn: () => marketApi.cancel(item.id),
    onSuccess: async () => {
      toast.info(`Đã rút lại. ${formatNumber(item.priceCoin)} Xu được hoàn lại ví chung.`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const busy = accept.isPending || decline.isPending || cancel.isPending;

  return (
    <article className="card approval">
      <div className="approval__head">
        <Avatar name={item.buyerName} src={avatarOf(item.buyerUserId)} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="approval__title">
            {mode === 'incoming' ? shortName(item.buyerName) : 'Bạn'} muốn đổi{' '}
            <strong>
              {item.itemEmoji} {item.itemTitle}
            </strong>
          </p>
          <p className="approval__meta">
            🪙 {formatNumber(item.priceCoin)} Xu đã được giữ · {timeAgo(item.createdAt)}
          </p>
        </div>
        <span className="icon-tile" aria-hidden="true">
          <Icon name="gift" />
        </span>
      </div>

      {mode === 'incoming' ? (
        <>
          <p className="text-sm text-muted">Bạn có thực hiện phần thưởng này được không? Từ chối thì Xu sẽ hoàn lại ví chung.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDeclining(true)}>
              Từ chối
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => accept.mutate()}>
              {accept.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} />}
              Nhận lời
            </button>
          </div>
        </>
      ) : (
        <div className="row row--between">
          <span className="chip chip--warning">
            <Icon name="clock" size={14} /> Chờ {partnerName} nhận lời
          </span>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => cancel.mutate()}>
            <Icon name="undo" size={16} /> Rút lại
          </button>
        </div>
      )}

      <BottomSheet open={declining} onClose={() => setDeclining(false)} title="Từ chối yêu cầu?">
        <div className="form">
          <p className="text-muted">
            {formatNumber(item.priceCoin)} Xu sẽ được hoàn lại ví chung. Bạn có thể nhắn lý do để {shortName(item.buyerName)} không buồn 😉
          </p>
          <label className="field">
            <span className="field__label">Lời nhắn (tuỳ chọn)</span>
            <input
              className="input"
              value={note}
              maxLength={200}
              placeholder="VD: Hôm nay bận quá, mai anh làm nhé"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setDeclining(false)}>
              Để sau
            </button>
            <button type="button" className="btn btn-danger" disabled={decline.isPending} onClick={() => decline.mutate()}>
              Từ chối
            </button>
          </div>
        </div>
      </BottomSheet>
    </article>
  );
}
