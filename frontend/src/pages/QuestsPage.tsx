import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { CoinChip } from '../components/WalletCard';
import { WaterRing } from '../components/WaterRing';
import { useAuth } from '../features/auth/AuthContext';
import { useApprovals } from '../features/approvals/useApprovals';
import { BucketCard } from '../features/bucket/BucketCard';
import { CHECKIN_KEY, QUESTS_KEY, WALLET_KEY, questsApi } from '../features/quests/api';
import { WATER_KEY, waterApi } from '../features/water/api';
import { WaterPhotoFlow } from '../features/water/WaterPhotoFlow';
import { ManualWaterSheet, WaterGoalSheet } from '../features/water/WaterSheets';
import { ApiRequestError } from '../lib/apiClient';
import { formatMl, formatToday, shortName } from '../lib/format';
import type { Quest } from '../lib/types';

function StatusChip({ status }: { status: Quest['status'] }) {
  if (status === 'rewarded') {
    return (
      <span className="chip chip--success">
        <Icon name="check" size={14} /> Đã nhận
      </span>
    );
  }
  if (status === 'completed') return <span className="chip chip--brand">Hoàn thành</span>;
  return <span className="chip">Đang làm</span>;
}

function RewardChips({ q }: { q: Quest }) {
  return (
    <div className="quest-card__rewards">
      <span className="chip">🪙 {q.coinReward} Xu tổng · chia đều</span>
      <span className="chip">✨ +{q.expReward} EXP</span>
    </div>
  );
}

function useClaim() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshMe } = useAuth();
  return useMutation({
    mutationFn: questsApi.claim,
    onSuccess: async (q) => {
      toast.success(`Thưởng chung: ${q.coinReward} Xu chia đều hai ví, +${q.expReward} EXP chung 🎉`);
      await Promise.all([qc.invalidateQueries({ queryKey: QUESTS_KEY }), qc.invalidateQueries({ queryKey: WALLET_KEY })]);
      await refreshMe();
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra'),
  });
}

function CheckinCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const status = useQuery({ queryKey: CHECKIN_KEY, queryFn: questsApi.checkinStatus });

  const checkin = useMutation({
    mutationFn: questsApi.checkin,
    onSuccess: async (r) => {
      toast.success(`Điểm danh xong! +${r.coinAwarded} Xu · +${r.expAwarded} EXP${r.leveledUp ? ' · Lên cấp 🎉' : ''}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: CHECKIN_KEY }),
        qc.invalidateQueries({ queryKey: QUESTS_KEY }),
        qc.invalidateQueries({ queryKey: WALLET_KEY }),
      ]);
      await refreshMe();
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra'),
  });

  if (status.isLoading) return <Skeleton height={168} />;
  const s = status.data;
  const done = Boolean(s?.checkedInToday);

  return (
    <div className="card checkin-card">
      <div className="row row--between">
        <div>
          <p className="text-sm text-muted">Chuỗi điểm danh</p>
          <div className="streak">
            <span className="streak__num">{s?.streak ?? 0}</span>
            <span className="strong">ngày{s && s.streak > 0 ? ' 🔥' : ''}</span>
          </div>
        </div>
        {partner && (
          <div className="row" style={{ gap: 8 }}>
            <Avatar name={partner.displayName} src={partner.avatarUrl} size={32} />
            <span className={`chip ${s?.partnerCheckedIn ? 'chip--success' : ''}`}>
              {s?.partnerCheckedIn ? `${shortName(partner.displayName)} đã điểm danh` : `${shortName(partner.displayName)} chưa điểm danh`}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`btn btn-lg btn-block ${done ? 'btn-secondary' : 'btn-primary'}`}
        disabled={done || checkin.isPending}
        onClick={() => checkin.mutate()}
      >
        {done ? (
          <>
            <Icon name="check" size={20} /> Đã điểm danh hôm nay
          </>
        ) : checkin.isPending ? (
          <>
            <span className="spinner" aria-hidden="true" /> Đang điểm danh…
          </>
        ) : (
          'Điểm danh hôm nay'
        )}
      </button>
    </div>
  );
}

function WaterQuestCard({ quest }: { quest: Quest | undefined }) {
  const water = useQuery({ queryKey: WATER_KEY, queryFn: waterApi.today, refetchOnWindowFocus: true });
  const { incomingWater } = useApprovals();
  const claim = useClaim();
  const [manualOpen, setManualOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);

  if (water.isLoading) return <Skeleton height={190} />;
  if (!water.data) return null;
  const w = water.data;

  return (
    <article className="card quest-card" aria-labelledby="water-quest-title">
      <div className="quest-card__head">
        <span className="icon-tile icon-tile--water" aria-hidden="true">
          <Icon name="droplet" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 id="water-quest-title" className="card__title">
            Uống đủ nước
          </h3>
          <p className="text-sm text-muted">Người yêu xác nhận ảnh thì mới được cộng</p>
        </div>
        {quest && <StatusChip status={quest.status} />}
      </div>

      {w.goalMl === null ? (
        <>
          <p className="text-muted">
            {w.pendingGoalProposal
              ? 'Đề xuất mục tiêu đang chờ người yêu đồng ý.'
              : 'Hai bạn chưa có mục tiêu nước. Thống nhất một con số để bắt đầu nhiệm vụ.'}
          </p>
          {w.pendingGoalProposal ? (
            <Link to="/notifications?filter=approvals" className="btn btn-outline btn-block">
              Xem đề xuất
            </Link>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => setGoalOpen(true)}>
              Đề xuất mục tiêu
            </button>
          )}
        </>
      ) : (
        <>
          <Link to="/quests/water" className="water-card__stats" style={{ textDecoration: 'none', color: 'inherit' }}>
            <WaterRing totalMl={w.totalMl} pendingMl={w.pendingMl} goalMl={w.goalMl} size={76} stroke={9} compact />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="water-card__amount">
                {formatMl(w.totalMl)} <span className="text-sm text-muted">/ {formatMl(w.goalMl)}</span>
              </p>
              {w.pendingMl > 0 ? (
                <p className="pending-note">
                  <Icon name="clock" size={14} /> +{formatMl(w.pendingMl)} chờ xác nhận
                </p>
              ) : (
                <p className="text-sm text-muted">{w.goalMet ? 'Đã đạt mục tiêu 🎉' : `Còn ${formatMl(w.remainingMl ?? 0)}`}</p>
              )}
            </div>
            <Icon name="chevronRight" className="text-muted" />
          </Link>

          {incomingWater > 0 && (
            <Link to="/notifications?filter=approvals" className="callout callout--water" style={{ textDecoration: 'none' }}>
              <Icon name="bell" size={16} />
              <span>
                Có <strong>{incomingWater}</strong> lượt uống nước của người yêu đang chờ bạn xác nhận
              </span>
            </Link>
          )}

          {quest?.status === 'completed' ? (
            <button type="button" className="btn btn-primary btn-block" disabled={claim.isPending} onClick={() => claim.mutate(quest.key)}>
              <Icon name="gift" size={18} /> Nhận thưởng
            </button>
          ) : (
            <div className="btn-row">
              <WaterPhotoFlow label="Chụp ảnh" className="btn btn-water" onManual={() => setManualOpen(true)} />
              <button type="button" className="btn btn-secondary" onClick={() => setManualOpen(true)}>
                Nhập tay
              </button>
            </div>
          )}
          {quest && <RewardChips q={quest} />}
        </>
      )}

      <ManualWaterSheet open={manualOpen} onClose={() => setManualOpen(false)} />
      <WaterGoalSheet open={goalOpen} onClose={() => setGoalOpen(false)} currentGoal={w.goalMl} />
    </article>
  );
}

function QuestCard({ quest }: { quest: Quest }) {
  const claim = useClaim();
  const pct = (quest.progress / quest.target) * 100;
  const icon = quest.type === 'checkin' ? 'heart' : quest.type === 'daily_question' ? 'messageCircle' : quest.type === 'duo_moment' ? 'camera' : 'star';
  return (
    <article className="card quest-card">
      <div className="quest-card__head">
        <span className="icon-tile" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="card__title">{quest.title}</h3>
          <p className="text-sm text-muted">{quest.description}</p>
        </div>
        <StatusChip status={quest.status} />
      </div>
      <div className="row">
        <div className="grow">
          <ProgressBar value={pct} tone={quest.status === 'in_progress' ? 'brand' : 'success'} label={quest.title} />
        </div>
        <span className="text-sm strong num">
          {quest.progress}/{quest.target}
        </span>
      </div>
      <div className="row row--between">
        <RewardChips q={quest} />
        {quest.status === 'completed' && (
          <button type="button" className="btn btn-primary" disabled={claim.isPending} onClick={() => claim.mutate(quest.key)}>
            <Icon name="gift" size={18} /> Nhận
          </button>
        )}
        {quest.type === 'daily_question' && quest.status === 'in_progress' && (
          <Link to="/questions/today" className="btn btn-outline">
            Mở câu hỏi
          </Link>
        )}
        {quest.type === 'duo_moment' && quest.status === 'in_progress' && (
          <Link to="/moments" className="btn btn-outline">
            Mở Khoảnh khắc
          </Link>
        )}
      </div>
    </article>
  );
}

export function QuestsPage() {
  const quests = useQuery({ queryKey: QUESTS_KEY, queryFn: questsApi.today });
  const water = quests.data?.find((q) => q.type === 'water_goal');
  const others = quests.data?.filter((q) => q.type !== 'water_goal') ?? [];
  const done = quests.data?.filter((q) => q.status !== 'in_progress').length ?? 0;

  return (
    <Page title="Nhiệm vụ" subtitle={formatToday()} actions={<CoinChip />}>
      <CheckinCard />

      <div className="section">
        <h2 className="section__title">
          Nhiệm vụ hôm nay
          {quests.data && quests.data.length > 0 && (
            <small>
              {done}/{quests.data.length} xong
            </small>
          )}
        </h2>
        {quests.isLoading && <Skeleton height={150} count={2} />}
        {quests.isError && <ErrorState onRetry={() => void quests.refetch()} />}
        {quests.isSuccess && (
          <>
            <WaterQuestCard quest={water} />
            {others.map((q) => (
              <QuestCard key={q.key} quest={q} />
            ))}
          </>
        )}
      </div>

      {/* CP3: the shared bucket list lives under the Quests tab (no new tab). */}
      <BucketCard />
    </Page>
  );
}
