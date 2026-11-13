import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { ImageViewer } from '../../components/ImageViewer';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useAvatarOf } from '../auth/useAvatarOf';
import { PROPOSAL_KEY, proposalsApi } from '../proposals/api';
import { QUESTS_KEY } from '../quests/api';
import { COUPLE_KEY } from '../couple/api';
import { WATER_KEY, WATER_PENDING_KEY, waterApi, waterImageKey } from '../water/api';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDate, formatDay, formatMl, formatVnd, shortName, timeAgo } from '../../lib/format';
import { refreshSavings, savingsError, savingsNeedsRetry } from '../savings/api';
import type { PendingWater, Proposal } from '../../lib/types';

function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.';
}

function usePartnerName(): string {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  return partner ? shortName(partner.displayName) : 'người ấy';
}

// ── Water ───────────────────────────────────────────────────

interface WaterProps {
  item: PendingWater;
  /** incoming = partner's submission I must review; outgoing = mine, waiting for partner. */
  mode: 'incoming' | 'outgoing';
}

export function WaterApprovalCard({ item, mode }: WaterProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const partnerName = usePartnerName();
  const avatarOf = useAvatarOf();
  const [viewing, setViewing] = useState(false);

  // Fetched once per log and reused for 4 min (URL valid 5 min) so polling never reloads the photo.
  const image = useQuery({
    queryKey: waterImageKey(item.id),
    queryFn: () => waterApi.imageUrl(item.id),
    enabled: item.hasImage,
    staleTime: 4 * 60_000,
  });

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: WATER_PENDING_KEY }),
      qc.invalidateQueries({ queryKey: WATER_KEY }),
      qc.invalidateQueries({ queryKey: QUESTS_KEY }),
    ]);

  const approve = useMutation({
    mutationFn: () => waterApi.approve(item.id),
    onSuccess: async () => {
      toast.success(`Đã xác nhận ${formatMl(item.amountMl)} cho ${shortName(item.submitterName)} 💧`);
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const reject = useMutation({
    mutationFn: () => waterApi.reject(item.id),
    onSuccess: async () => {
      toast.info(mode === 'incoming' ? 'Đã từ chối, lượng nước không được tính.' : 'Đã rút lại.');
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <article className="card approval">
      <div className="approval__head">
        <Avatar name={item.submitterName} src={avatarOf(item.userId)} size={40} />
        <div className="grow" style={{ flex: 1, minWidth: 0 }}>
          <p className="approval__title">
            {mode === 'incoming' ? shortName(item.submitterName) : 'Bạn'} đã uống{' '}
            <span className="text-water strong">{formatMl(item.amountMl)}</span>
          </p>
          <p className="approval__meta">
            {item.source === 'ai' ? 'AI ước lượng từ ảnh' : 'Nhập thủ công'} · {timeAgo(item.createdAt)}
          </p>
        </div>
      </div>

      {item.hasImage && (
        <button
          type="button"
          className="approval__photo"
          onClick={() => setViewing(true)}
          aria-label="Xem ảnh lớn"
          disabled={!image.data}
        >
          {image.data ? (
            <img src={image.data.url} alt={`Ảnh ly nước của ${item.submitterName}`} loading="lazy" />
          ) : (
            <div className="skeleton" />
          )}
        </button>
      )}

      {mode === 'incoming' ? (
        <>
          <p className="text-sm text-muted">Lượng nước chỉ được cộng khi bạn xác nhận.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => reject.mutate()}>
              Từ chối
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => approve.mutate()}>
              {approve.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} />}
              Xác nhận
            </button>
          </div>
        </>
      ) : (
        <div className="row row--between">
          <span className="chip chip--warning">
            <Icon name="clock" size={14} /> Chờ {partnerName} xác nhận
          </span>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reject.mutate()}>
            <Icon name="undo" size={16} /> Rút lại
          </button>
        </div>
      )}

      {viewing && <ImageViewer src={image.data?.url} alt="Ảnh ly nước" onClose={() => setViewing(false)} />}
    </article>
  );
}

// ── Proposals ───────────────────────────────────────────────

function describeProposal(p: Proposal, timeZone?: string): { title: string; detail: string; icon: 'calendar' | 'droplet' | 'creditCard' } {
  if (p.kind === 'savings_goal' || p.kind === 'savings_goal_update') {
    const name = `${String(p.payload.emoji ?? '')} ${String(p.payload.title ?? 'Quỹ chung')}`.trim();
    const changes = [
      typeof p.payload.targetVnd === 'number' ? `Mục tiêu ${formatVnd(p.payload.targetVnd)}` : '',
      'dueOn' in p.payload ? (p.payload.dueOn ? `Hạn ${formatDay(String(p.payload.dueOn))}` : 'Không có hạn') : '',
    ].filter(Boolean).join(' · ');
    return {
      title: p.kind === 'savings_goal' ? 'Tạo quỹ chung' : p.payload.close ? 'Đóng quỹ chung' : 'Đổi mục tiêu / hạn quỹ',
      detail: `${name}${changes ? ` · ${changes}` : ''}${p.payload.close ? ' · Giữ lịch sử, không thể góp / rút / xóa thêm' : ''}`,
      icon: 'creditCard',
    };
  }
  if (p.kind === 'anniversary_date') {
    return {
      title: 'Đổi ngày bắt đầu yêu',
      detail: `Thành ${formatDate(`${String(p.payload.date)}T00:00:00Z`, timeZone ?? 'UTC')}`,
      icon: 'calendar',
    };
  }
  return {
    title: 'Mục tiêu nước mới',
    detail: `${formatMl(Number(p.payload.goalMl))} mỗi người / ngày`,
    icon: 'droplet',
  };
}

export function ProposalApprovalCard({ proposal, mode }: { proposal: Proposal; mode: 'incoming' | 'outgoing' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshMe } = useAuth();
  const partnerName = usePartnerName();
  const d = describeProposal(proposal);
  const isSavings = proposal.kind === 'savings_goal' || proposal.kind === 'savings_goal_update';
  const retryApplication = savingsNeedsRetry(proposal);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: PROPOSAL_KEY }),
      qc.invalidateQueries({ queryKey: COUPLE_KEY }),
      qc.invalidateQueries({ queryKey: WATER_KEY }),
      qc.invalidateQueries({ queryKey: QUESTS_KEY }),
    ]);
    if (isSavings) await refreshSavings(qc);
    await refreshMe();
  };
  const approve = useMutation({
    mutationFn: () => proposalsApi.approve(proposal.id),
    onSuccess: async (result) => {
      if (isSavings && result.status !== 'approved') toast.info('Đã ghi nhận đồng ý. Thay đổi chưa áp dụng xong, hãy thử lại.');
      else toast.success('Đã đồng ý — thay đổi được áp dụng 🎉');
      await refresh();
    },
    onError: async (err) => {
      toast.error(isSavings ? savingsError(err) : errorText(err));
      // A failed response may follow a committed approval/effect; reload its retry state.
      if (isSavings) await refreshSavings(qc);
    },
  });
  const reject = useMutation({
    mutationFn: () => proposalsApi.reject(proposal.id),
    onSuccess: async (result) => {
      toast.info(isSavings && result.status === 'approved' ? 'Thay đổi đã được áp dụng, không thể từ chối nữa.' : mode === 'incoming' ? 'Đã từ chối đề xuất.' : 'Đã hủy đề xuất.');
      await refresh();
    },
    onError: async (err) => {
      toast.error(isSavings ? savingsError(err) : errorText(err));
      if (isSavings) await refreshSavings(qc);
    },
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <article className="card approval">
      <div className="approval__head">
        <span className={`icon-tile${d.icon === 'droplet' ? ' icon-tile--water' : ''}`} aria-hidden="true">
          <Icon name={d.icon} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="approval__title">{d.title}</p>
          <p className="approval__meta">
            {d.detail} · {timeAgo(proposal.createdAt)}
          </p>
        </div>
      </div>
      {retryApplication && <p className="text-sm" role="status">Cả hai đã đồng ý nhưng thay đổi chưa áp dụng xong. Thử lại để hoàn tất, không tạo thêm quỹ.</p>}
      {mode === 'incoming' || retryApplication ? (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => reject.mutate()}>
            Từ chối
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => approve.mutate()}>
            <Icon name="check" size={18} /> {retryApplication ? 'Thử lại' : 'Đồng ý'}
          </button>
        </div>
      ) : (
        <div className="row row--between">
          <span className="chip chip--warning">
            <Icon name="clock" size={14} /> Chờ {partnerName} đồng ý
          </span>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reject.mutate()}>
            Hủy
          </button>
        </div>
      )}
    </article>
  );
}
