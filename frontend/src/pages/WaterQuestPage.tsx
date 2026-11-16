import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { ImageViewer } from '../components/ImageViewer';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { WaterRing } from '../components/WaterRing';
import { useAuth } from '../features/auth/AuthContext';
import { useApprovals } from '../features/approvals/useApprovals';
import { WATER_KEY, waterApi, waterImageKey } from '../features/water/api';
import { WaterPhotoFlow } from '../features/water/WaterPhotoFlow';
import { ManualWaterSheet, WaterGoalSheet } from '../features/water/WaterSheets';
import { PushSuggestCard } from '../features/push/PushSuggestCard';
import { formatMl, formatTime, shortName } from '../lib/format';
import type { WaterLogView } from '../lib/types';

function LogStatus({ log, myId }: { log: WaterLogView; myId: string | undefined }) {
  if (log.status === 'approved') return <span className="chip chip--success">Đã xác nhận</span>;
  if (log.status === 'pending') return <span className="chip chip--warning">Chờ duyệt</span>;
  if (log.reviewedBy === myId) return <span className="chip">Đã rút lại</span>;
  return <span className="chip chip--danger">Bị từ chối</span>;
}

function LogThumb({ log, onOpen }: { log: WaterLogView; onOpen: (url: string) => void }) {
  const image = useQuery({
    queryKey: waterImageKey(log.id),
    queryFn: () => waterApi.imageUrl(log.id),
    enabled: log.hasImage,
    staleTime: 4 * 60_000,
  });
  if (!log.hasImage) {
    return (
      <span className="icon-tile icon-tile--neutral" aria-hidden="true">
        <Icon name="edit" size={18} />
      </span>
    );
  }
  if (!image.data) return <span className="thumb skeleton" aria-hidden="true" />;
  return (
    <button type="button" className="icon-btn" style={{ padding: 0 }} onClick={() => onOpen(image.data.url)} aria-label="Xem ảnh">
      <img className="thumb" src={image.data.url} alt="" loading="lazy" />
    </button>
  );
}

/** /quests/water — the water quest in detail (reached from the Quests tab). */
export function WaterQuestPage() {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';
  const today = useQuery({ queryKey: WATER_KEY, queryFn: waterApi.today, refetchOnWindowFocus: true });
  const { incomingWater } = useApprovals();
  const [manualOpen, setManualOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <Page title="Uống nước" back="/quests">
      {today.isLoading && <Skeleton height={300} />}
      {today.isError && <ErrorState onRetry={() => void today.refetch()} />}
      {today.data && (
        <>
          <div className="card water-hero">
            <WaterRing totalMl={today.data.totalMl} pendingMl={today.data.pendingMl} goalMl={today.data.goalMl} />
            {today.data.goalMl === null ? (
              <p className="text-muted">Chưa có mục tiêu — hãy đề xuất một con số cho cả hai.</p>
            ) : today.data.goalMet ? (
              <p className="strong">Đã đạt mục tiêu hôm nay 🎉</p>
            ) : (
              <p className="text-muted">
                Còn <strong className="text-water">{formatMl(today.data.remainingMl ?? 0)}</strong> nữa
              </p>
            )}
            {today.data.pendingMl > 0 && (
              <p className="pending-note">
                <Icon name="clock" size={14} /> +{formatMl(today.data.pendingMl)} đang chờ {partnerName} xác nhận
              </p>
            )}
          </div>

          <WaterPhotoFlow onManual={() => setManualOpen(true)} />
          <button type="button" className="btn btn-outline btn-block" onClick={() => setManualOpen(true)}>
            <Icon name="edit" size={18} /> Nhập thủ công
          </button>

          <PushSuggestCard space="couple" text={`Biết ngay khi ${partnerName} xác nhận, gửi nước cho bạn duyệt, đăng bài hay trả lời câu hỏi.`} />

          {incomingWater > 0 && (
            <Link to="/notifications?filter=approvals" className="attention">
              <span className="icon-tile icon-tile--warning" aria-hidden="true">
                <Icon name="bell" />
              </span>
              <span className="attention__body">
                <span className="attention__title">{partnerName} đang chờ bạn xác nhận</span>
                <span className="attention__meta" style={{ display: 'block' }}>
                  {incomingWater} lượt uống nước
                </span>
              </span>
              <Icon name="chevronRight" />
            </Link>
          )}

          <div className="callout">
            <Icon name="shield" size={16} />
            <span>
              Ảnh được lưu riêng tư trên AWS S3 và gửi tới AI (beeknoee) để ước lượng ml. Chỉ hai bạn xem được ảnh;{' '}
              {partnerName} xem ảnh để xác nhận.
            </span>
          </div>

          <div className="section">
            <h2 className="section__title">Hôm nay của bạn</h2>
            {today.data.logs.length === 0 ? (
              <div className="card">
                <EmptyState art="💧" title="Chưa có lượt nào" hint="Chụp ảnh ly nước đầu tiên trong ngày nhé." />
              </div>
            ) : (
              <div className="list">
                {today.data.logs.map((log) => (
                  <div key={log.id} className="list__item">
                    <LogThumb log={log} onOpen={setViewing} />
                    <div className="list__body">
                      <p className={`log-row__amount${log.status === 'rejected' ? ' is-void' : ''}`}>{formatMl(log.amountMl)}</p>
                      <p className="list__meta">
                        {log.source === 'ai' ? 'AI ước lượng' : 'Nhập tay'} · {formatTime(log.createdAt)}
                      </p>
                    </div>
                    <LogStatus log={log} myId={me?.user.id} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="list">
            {today.data.pendingGoalProposal ? (
              <Link to="/notifications?filter=approvals" className="list__item">
                <span className="icon-tile icon-tile--water" aria-hidden="true">
                  <Icon name="droplet" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label" style={{ display: 'block' }}>
                    Mục tiêu mỗi ngày
                  </span>
                  <span className="list__meta">Có đề xuất mới đang chờ duyệt</span>
                </span>
                <span className="list__value">{today.data.goalMl ? formatMl(today.data.goalMl) : 'Chưa đặt'}</span>
                <Icon name="chevronRight" className="text-muted" />
              </Link>
            ) : (
              <button type="button" className="list__item" onClick={() => setGoalOpen(true)}>
                <span className="icon-tile icon-tile--water" aria-hidden="true">
                  <Icon name="droplet" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label" style={{ display: 'block' }}>
                    Mục tiêu mỗi ngày
                  </span>
                  <span className="list__meta">Đổi mục tiêu cần cả hai đồng ý</span>
                </span>
                <span className="list__value">{today.data.goalMl ? formatMl(today.data.goalMl) : 'Chưa đặt'}</span>
                <Icon name="chevronRight" className="text-muted" />
              </button>
            )}
          </div>

          <ManualWaterSheet open={manualOpen} onClose={() => setManualOpen(false)} />
          <WaterGoalSheet open={goalOpen} onClose={() => setGoalOpen(false)} currentGoal={today.data.goalMl} />
          <ImageViewer src={viewing} alt="Ảnh ly nước" onClose={() => setViewing(null)} />
        </>
      )}
    </Page>
  );
}
