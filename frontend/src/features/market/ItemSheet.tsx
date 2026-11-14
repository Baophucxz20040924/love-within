import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { WALLET_KEY, walletApi } from '../quests/api';
import { ApiRequestError } from '../../lib/apiClient';
import { formatNumber, shortName } from '../../lib/format';
import type { MarketItem } from '../../lib/types';
import { MARKET_KEY, MARKET_PENDING_KEY, REDEMPTIONS_KEY, marketApi } from './api';

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const missing = (err.details as { missing?: number } | undefined)?.missing;
    return missing ? `Không đủ Xu — còn thiếu ${formatNumber(missing)} Xu.` : err.message;
  }
  return 'Có lỗi xảy ra, thử lại nhé.';
}

interface Props {
  item: MarketItem | null;
  onClose: () => void;
  onEdit: (item: MarketItem) => void;
  /** After a request is sent, the page switches to the "Đã đổi" tab. */
  onRequested: () => void;
}

/**
 * Item details. Partner's item → "Gửi yêu cầu đổi" (coins held until they answer).
 * My item → edit / remove (I'm the one who performs it, so I can't redeem it).
 */
export function ItemSheet({ item, onClose, onEdit, onRequested }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';
  const wallet = useQuery({ queryKey: WALLET_KEY, queryFn: walletApi.get });
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setConfirming(false), [item]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: MARKET_KEY }),
      qc.invalidateQueries({ queryKey: REDEMPTIONS_KEY }),
      qc.invalidateQueries({ queryKey: MARKET_PENDING_KEY }),
      qc.invalidateQueries({ queryKey: WALLET_KEY }),
    ]);
    await refreshMe();
  };
  const request = useMutation({
    mutationFn: (id: string) => marketApi.request(id),
    onSuccess: async (r) => {
      toast.success(`Đã gửi yêu cầu cho ${partnerName}. Ví còn ${formatNumber(r.balance)} Xu.`);
      onClose();
      await refresh();
      onRequested();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => marketApi.archive(id),
    onSuccess: async () => {
      toast.info('Đã gỡ món khỏi gian hàng');
      onClose();
      await refresh();
    },
  });

  useEffect(() => {
    if (!item) return;
    if (request.isError) request.reset();
    if (archive.isError) archive.reset();
  }, [item, request.reset, archive.reset]);

  const balance = wallet.data?.coinBalance ?? 0;
  const missing = item ? Math.max(0, item.priceCoin - balance) : 0;

  return (
    <BottomSheet open={item !== null} onClose={onClose} title={item?.title ?? ''}>
      {item && (
        <div className="stack">
          <div className="item-sheet__art" aria-hidden="true">
            {item.emoji}
          </div>
          {item.description && <p className="text-muted">{item.description}</p>}
          <div className="row row--between">
            <span className="coin-chip">🪙 {formatNumber(item.priceCoin)} Xu</span>
            <span className="text-sm text-muted">Ví chung: {formatNumber(balance)} Xu</span>
          </div>

          {(request.isError || archive.isError) && <p className="form-feedback" role="alert">{errorText(request.isError ? request.error : archive.error)}</p>}
          {item.isMine ? (
            <>
              <div className="callout">
                <Icon name="gift" size={16} />
                <span>Món này do bạn đăng — {partnerName} sẽ đổi và bạn là người thực hiện.</span>
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn-outline" onClick={() => onEdit(item)}>
                  <Icon name="edit" size={16} /> Sửa
                </button>
                <button type="button" className="btn btn-danger" disabled={archive.isPending} onClick={() => archive.mutate(item.id)}>
                  <Icon name="trash" size={16} /> Gỡ
                </button>
              </div>
            </>
          ) : missing > 0 ? (
            <button type="button" className="btn btn-secondary btn-lg btn-block" disabled>
              Còn thiếu {formatNumber(missing)} Xu
            </button>
          ) : confirming ? (
            <div className="card card--tint-brand stack">
              <p>
                Gửi yêu cầu đổi <strong>{item.title}</strong>? <strong>{formatNumber(item.priceCoin)} Xu</strong> sẽ được giữ lại cho tới
                khi {partnerName} nhận lời; nếu từ chối, Xu hoàn về ví.
              </p>
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
                  Thôi
                </button>
                <button type="button" className="btn btn-primary" disabled={request.isPending} onClick={() => request.mutate(item.id)}>
                  {request.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={18} />}
                  Gửi yêu cầu
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => setConfirming(true)}>
                <Icon name="gift" size={18} /> Đổi món này
              </button>
              <p className="text-sm text-muted center">{partnerName} sẽ nhận thông báo và trả lời có thực hiện được không.</p>
            </>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
