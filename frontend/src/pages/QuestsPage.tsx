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
import { CHECKIN_KEY, QUESTS_KEY, questsApi, refreshQuestRewards } from '../features/quests/api';
import { WATER_KEY, waterApi } from '../features/water/api';
import { WaterPhotoFlow } from '../features/water/WaterPhotoFlow';
import { ManualWaterSheet, WaterGoalSheet } from '../features/water/WaterSheets';
import { ApiRequestError } from '../lib/apiClient';
import { formatDay, formatMl, formatNumber, formatToday, shortName } from '../lib/format';
import type { CheckinResult, CheckinStatus, Quest } from '../lib/types';

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

export function isActivityExpQuest(q: Quest): boolean {
  return q.rewardPolicy?.version === 2 && (q.type === 'checkin' || q.type === 'duo_moment');
}

export function RewardChips({ q }: { q: Quest }) {
  return (
    <div className="quest-card__rewards">
      <span className="chip">{isActivityExpQuest(q) ? '0 Xu từ nhiệm vụ · Xu tự cộng riêng' : `${formatNumber(q.coinReward)} Xu tổng · chia đều hai ví`}</span>
      <span className="chip">+{formatNumber(q.expReward)} EXP chung</span>
    </div>
  );
}

export function checkinSuccessMessage(r: CheckinResult): string {
  const reward = r.reward;
  const coins = reward?.policyVersion !== 2
    ? `+${formatNumber(r.coinAwarded)} Xu của bạn`
    : reward.status === 'awarded'
      ? `Đã cộng ${formatNumber(reward.coinAwarded)} Xu của bạn`
      : reward.status === 'pending'
        ? 'Đã lưu, đang xử lý Xu đủ đôi'
        : 'Chờ cả hai điểm danh để nhận Xu';
  return `Điểm danh xong! ${coins} · +${r.expAwarded} EXP${r.leveledUp ? ' · Lên cấp' : ''}`;
}

export function CheckinReward({ status: s }: { status: CheckinStatus }) {
  const r = s.reward;
  if (!r) return <p className="text-sm text-muted">Xu điểm danh theo chính sách của ngày; xem số thực nhận trong lịch sử ví.</p>;
  if (r.policyVersion === 1) return <div className="stack">
    <p className="text-sm">Ngày này dùng chính sách cũ: Xu điểm danh cá nhân và thưởng nhiệm vụ theo mức cũ. Xem số thực nhận trong lịch sử ví.</p>
    <p className="text-sm text-muted">Chính sách mới từ {formatDay(r.effectiveDate)}: chỉ cộng Xu khi cả hai điểm danh. Lịch sử trước đó giữ nguyên.</p>
  </div>;
  const settledStreak = r.commonStreak !== null;
  return <div className="stack" aria-live="polite">
    <p className="text-sm strong">{settledStreak
      ? `${formatNumber(r.baseCoin)} cơ bản + ${formatNumber(r.bonusCoin)} thưởng chuỗi = ${formatNumber(r.baseCoin + r.bonusCoin)} Xu của bạn`
      : 'Mỗi người: 5 Xu cơ bản + thưởng chuỗi chung khi cả hai điểm danh.'}</p>
    <p className="text-sm">{r.status === 'awarded'
      ? `Đã cộng ${formatNumber(r.coinAwarded)} Xu vào ví của bạn.`
      : r.status === 'pending'
        ? 'Đã lưu điểm danh đủ đôi, đang xử lý cộng Xu. Không cần điểm danh lại.'
        : !s.checkedInToday && !s.partnerCheckedIn
          ? 'Chưa có Xu: cả hai cần điểm danh hôm nay.'
          : !s.checkedInToday
            ? 'Người ấy đã điểm danh. Đến lượt bạn để cả hai nhận Xu.'
            : 'Bạn đã điểm danh. Chờ người ấy để cả hai nhận Xu.'}</p>
    <p className="text-sm text-muted">Chuỗi chung ngày 1: 5 Xu/người; ngày 2: 6; ngày 3: 7… Thiếu một ngày đủ đôi thì bắt đầu lại.</p>
    <p className="text-sm text-muted">EXP riêng luồng Xu: mỗi lần điểm danh +5 EXP; nhiệm vụ đủ đôi nhận thêm 5 EXP chung, không thêm Xu.</p>
    <p className="text-sm text-muted">Áp dụng từ {formatDay(r.effectiveDate)}. Chuỗi thưởng chung mới không cộng bù ngày cũ.</p>
  </div>;
}

function useClaim() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshMe } = useAuth();
  return useMutation({
    mutationFn: questsApi.claim,
    onSuccess: (q) => {
      toast.success(isActivityExpQuest(q)
        ? `Đã nhận +${q.expReward} EXP chung. Xu hoạt động được tự cộng riêng, nhiệm vụ không cộng thêm Xu.`
        : `Đã nhận ${q.coinReward} Xu tổng chia đều hai ví, +${q.expReward} EXP chung.`);
      refreshQuestRewards(qc);
      void refreshMe().catch(() => undefined);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra'),
  });
}

function CheckinCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const status = useQuery({ queryKey: CHECKIN_KEY, queryFn: questsApi.checkinStatus,
    refetchInterval: (query) => query.state.data?.reward?.status === 'pending' ? 5_000 : 30_000,
    refetchOnWindowFocus: true,
  });

  const checkin = useMutation({
    mutationFn: questsApi.checkin,
    onSuccess: (r) => {
      toast.success(checkinSuccessMessage(r));
      // Use the confirmed receipt immediately, not the latency of a follow-up read.
      qc.setQueryData<CheckinStatus>(CHECKIN_KEY, (old) => old?.localDate === r.localDate
        ? { ...old, checkedInToday: true, streak: r.streak, reward: r.reward,
          partnerCheckedIn: r.reward?.policyVersion === 2 && ['pending', 'awarded'].includes(r.reward.status) ? true : old.partnerCheckedIn }
        : old);
      refreshQuestRewards(qc);
      void refreshMe().catch(() => undefined);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra'),
  });

  if (status.isLoading) return <Skeleton height={168} />;
  if (status.isError && !status.data) return <ErrorState onRetry={() => void status.refetch()} />;
  const s = status.data;
  const done = Boolean(s?.checkedInToday);
  const pairPolicy = s?.reward?.policyVersion === 2;
  const streak = pairPolicy ? s.reward.commonStreak : s?.streak;

  return (
    <div className="card checkin-card">
      <div className="row row--between">
        <div>
          <p className="text-sm text-muted">{pairPolicy ? 'Chuỗi thưởng chung' : 'Chuỗi điểm danh cá nhân'}</p>
          <div className="streak">
            <span className="streak__num">{streak ?? '—'}</span>
            <span className="strong">{pairPolicy && streak == null ? 'chờ đủ đôi' : 'ngày'}</span>
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
      {s && <CheckinReward status={s} />}
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
  const expOnly = isActivityExpQuest(quest);
  const description = expOnly
    ? quest.type === 'checkin'
      ? 'Cả hai điểm danh để nhận EXP chung. Xu đủ đôi và thưởng chuỗi tự cộng riêng vào mỗi ví.'
      : 'Cả hai chụp đúng giờ để hoàn thành nhiệm vụ EXP. Mỗi ảnh đầu ngày tự cộng 10 Xu; đủ đôi đúng giờ thêm 10 Xu/người.'
    : quest.description;
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
          <p className="text-sm text-muted">{description}</p>
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
      <div className="row row--between quest-card__actions">
        <RewardChips q={quest} />
        {quest.status === 'completed' && (
          <button type="button" className="btn btn-primary" disabled={claim.isPending} onClick={() => claim.mutate(quest.key)}>
            <Icon name="gift" size={18} /> {expOnly ? 'Nhận EXP' : 'Nhận thưởng'}
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
  const policy = quests.data?.find((q) => q.rewardPolicy)?.rewardPolicy;

  return (
    <Page title="Nhiệm vụ" subtitle={formatToday()} actions={<CoinChip />}>
      <CheckinCard />
      {policy && <p className="text-sm text-muted">Chính sách Xu mới {policy.version === 2 ? 'áp dụng' : 'bắt đầu'} từ {formatDay(policy.effectiveDate)} ({policy.timezone}). Điểm danh và Khoảnh khắc tự cộng Xu theo hoạt động; nhiệm vụ tương ứng chỉ nhận EXP từ ngày này. Nước và các nhiệm vụ khác giữ nguyên thưởng.</p>}

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
