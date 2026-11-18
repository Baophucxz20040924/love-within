import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { WalletCard } from '../components/WalletCard';
import { useAuth } from '../features/auth/AuthContext';
import { useApprovals } from '../features/approvals/useApprovals';
import { COUPLE_KEY, PULSE_KEY, coupleApi } from '../features/couple/api';
import { UpcomingCard } from '../features/events/UpcomingCard';
import { FINANCE_CONNECTION_KEY, financeApi, financeSummaryKey } from '../features/finance/api';
import { LettersCard } from '../features/letters/LettersCard';
import { MomentCard } from '../features/moments/MomentCard';
import { HeroMoods } from '../features/nudges/MoodControls';
import { FloatingHearts, NudgeHeart, NudgeKindSheet, NudgeLine } from '../features/nudges/NudgeControls';
import { useNudgeSender } from '../features/nudges/useNudgeSender';
import { QuestionCard } from '../features/questions/QuestionCard';
import { SavingsHomeCard } from '../features/savings/SavingsViews';
import { CHECKIN_KEY, QUESTS_KEY, questsApi } from '../features/quests/api';
import { formatDate, formatNumber, formatToday, formatVnd, localDateOf, shortName } from '../lib/format';
import type { Couple, CouplePulse, PulseMoment } from '../lib/types';
import { tokenStore } from '../lib/tokenStore';
import { appLockState, subscribeAppLock } from '../features/appLock/store';

function Hero({ couple, myId, pulse }: { couple: Couple; myId: string | undefined; pulse: CouplePulse | undefined }) {
  const me = couple.members.find((m) => m.id === myId);
  const partner = couple.members.find((m) => m.id !== myId);
  const partnerName = partner ? shortName(partner.displayName) : 'Người ấy';
  const days = couple.daysInLove ?? 0;
  const from = couple.lastMilestone ?? 0;
  const next = couple.nextMilestone;
  const pct = next ? ((days - from) / (next.days - from)) * 100 : 100;
  const isMilestoneToday = couple.lastMilestone !== null && couple.lastMilestone === days;
  // CP5: heart button (tap = 💗 Nhớ, long-press = other kinds), what the partner sent today, today's moods.
  const sender = useNudgeSender(partnerName);
  const [kindsOpen, setKindsOpen] = useState(false);

  return (
    <section className="hero" aria-label="Số ngày yêu">
      {partner && <NudgeHeart sender={sender} partnerName={partnerName} onMore={() => setKindsOpen(true)} />}
      <FloatingHearts userId={myId ?? ''} nudges={pulse?.nudges} />
      <div className="hero__names">
        <span className="avatar-pair">
          {me && <Avatar name={me.displayName} src={me.avatarUrl} size={36} ring />}
          {partner && <Avatar name={partner.displayName} src={partner.avatarUrl} size={36} ring />}
        </span>
        <span>
          {me ? shortName(me.displayName) : ''} & {partner ? shortName(partner.displayName) : ''}
        </span>
      </div>
      <div className="hero__journey">
        <div className="hero__figure">
          <p className="hero__days">{formatNumber(days)}</p>
          <p className="hero__label">ngày bên nhau</p>
          {couple.anniversaryDate && (
            <p className="hero__since">Từ {formatDate(couple.anniversaryDate, couple.timezone)}</p>
          )}
        </div>
        <div className="hero__milestone">
        {isMilestoneToday ? (
          <span>🎉 Hôm nay tròn {formatNumber(days)} ngày! Chúc mừng hai bạn.</span>
        ) : next ? (
          <span>
            Còn <strong>{formatNumber(next.remaining)} ngày</strong> tới mốc {formatNumber(next.days)} ngày
          </span>
        ) : (
          <span>Hai bạn đã vượt qua mọi cột mốc 💞</span>
        )}
          {next && !isMilestoneToday && <ProgressBar value={pct} label="Tiến tới cột mốc tiếp theo" />}
        </div>
      </div>
      {partner && pulse && (pulse.moods || (pulse.nudges?.receivedToday ?? 0) > 0) && (
        <div className="hero-today">
          {pulse.nudges && <NudgeLine nudges={pulse.nudges} partnerName={partnerName} sender={sender} />}
          {pulse.moods && <HeroMoods mine={pulse.moods.mine} partner={pulse.moods.partner} partnerName={partnerName} />}
        </div>
      )}
      {partner && <NudgeKindSheet open={kindsOpen} onClose={() => setKindsOpen(false)} sender={sender} partnerName={partnerName} />}
    </section>
  );
}

function TodaySummary() {
  const checkin = useQuery({ queryKey: CHECKIN_KEY, queryFn: questsApi.checkinStatus });
  const quests = useQuery({ queryKey: QUESTS_KEY, queryFn: questsApi.today });
  const done = quests.data?.filter((q) => q.status !== 'in_progress').length ?? 0;
  const total = quests.data?.length ?? 0;
  const claimable = quests.data?.filter((q) => q.status === 'completed').length ?? 0;

  return (
    <Link to="/quests" className="card card--link">
      <div className="row">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="quests" />
        </span>
        <div className="grow">
          <p className="card__title">Hôm nay</p>
          <p className="text-sm text-muted">
            {checkin.isPending || quests.isPending
              ? 'Đang tải hoạt động hôm nay…'
              : checkin.isError || quests.isError
                ? 'Chưa tải được hoạt động · Mở để thử lại'
                : `${checkin.data.checkedInToday ? 'Đã điểm danh' : 'Chưa điểm danh'} · ${done}/${total} nhiệm vụ xong`}
          </p>
        </div>
        {claimable > 0 ? <span className="chip chip--brand">{claimable} quà chờ nhận</span> : <Icon name="chevronRight" className="text-muted" />}
      </div>
    </Link>
  );
}

/** "Dòng tiền tháng N": my totals this month, or an invitation to link a bank account. */
function FinanceCard({ timezone }: { timezone: string }) {
  const month = localDateOf(new Date(), timezone).slice(0, 7);
  const conn = useQuery({ queryKey: FINANCE_CONNECTION_KEY, queryFn: financeApi.connection });
  const linked = conn.data?.linked ?? false;
  const summary = useQuery({
    queryKey: financeSummaryKey('mine', month),
    queryFn: () => financeApi.summary('mine', month),
    enabled: linked,
  });
  if (!conn.data) {
    return (
      <div className="card">
        <p className="card__title">Dòng tiền tháng {Number(month.slice(5))}</p>
        {conn.isError ? (
          <><p className="text-sm text-muted" role="alert">Chưa tải được kết nối ngân hàng.</p>
            <button type="button" className="btn btn-outline" disabled={conn.isFetching} onClick={() => void conn.refetch()}>Thử lại</button></>
        ) : <p className="text-sm text-muted" role="status">Đang tải dòng tiền…</p>}
      </div>
    );
  }

  const c = conn.data;
  const s = summary.data;
  const text =
    c.status === null
      ? 'Liên kết MBBank để tự ghi tiền vào / ra'
      : c.status === 'revoked'
        ? 'Đã ngắt kết nối ngân hàng'
        : s
          ? (
              <>
                <span className="nowrap">Vào +{formatVnd(s.totalIn)}</span> · <span className="nowrap">Ra −{formatVnd(s.totalOut)}</span>
              </>
            )
          : summary.isError
            ? 'Chưa tải được tổng thu / chi'
            : c.status === 'error' && !linked
              ? 'Mất kết nối ngân hàng · Mở Dòng tiền để thử lại'
              : 'Đang tải…';
  return (
    <div className="stack" style={{ gap: 8 }}>
    <Link to="/finance" className="card card--link">
      <div className="row">
        <span className={`icon-tile${c.status === 'error' ? ' icon-tile--warning' : ' icon-tile--success'}`} aria-hidden="true">
          <Icon name="creditCard" />
        </span>
        <div className="grow">
          <p className="card__title">Dòng tiền tháng {Number(month.slice(5))}</p>
          <p className="text-sm text-muted num">{text}</p>
        </div>
        {c.status === 'error' ? <span className="chip chip--warning">Mất kết nối</span> : <Icon name="chevronRight" className="text-muted" />}
      </div>
    </Link>
    {(conn.isError || summary.isError) && (
      <div>
        <p className="text-sm text-muted" role="alert">Không cập nhật được dòng tiền. {s ? 'Đang hiển thị số liệu đã tải trước đó.' : ''}</p>
        <button type="button" className="btn btn-outline" disabled={conn.isFetching || summary.isFetching} onClick={() => { void conn.refetch(); if (linked) void summary.refetch(); }}>Thử lại</button>
      </div>
    )}
    </div>
  );
}

function HomeMoment({ moment }: { moment: PulseMoment | null | undefined }) {
  const [pending, setPending] = useState<{ moment: PulseMoment; generation: string } | null>(null);
  useEffect(() => {
    const clearInvalid = () => setPending((old) => old && (!tokenStore.isCurrent(old.generation) || appLockState().discard) ? null : old);
    const unsubscribe = subscribeAppLock(clearInvalid);
    window.addEventListener('storage', clearInvalid);
    return () => { unsubscribe(); window.removeEventListener('storage', clearInvalid); };
  }, []);
  const retained = pending && tokenStore.isCurrent(pending.generation) && !appLockState().discard ? pending.moment : null;
  const sameTarget = retained && moment?.localDate === retained.localDate && moment.sessionId === retained.sessionId;
  const shown = retained ? (sameTarget ? moment : retained) : moment?.state === 'open' ? moment : null;
  if (!shown) return null;
  return <MomentCard key={`${shown.localDate}/${shown.sessionId}`} moment={shown} onPendingChange={(hasDraft) => {
    setPending((old) => hasDraft
      ? appLockState().discard ? null : old ?? { moment: shown, generation: tokenStore.generation() }
      : old?.moment.localDate === shown.localDate && old.moment.sessionId === shown.sessionId ? null : old);
  }} />;
}

export function HomePage() {
  const { me } = useAuth();
  const couple = useQuery({ queryKey: COUPLE_KEY, queryFn: coupleApi.get });
  // One combined poll for the Home cards (plan/ENGINEERING_WORKFLOW.md): every 30 s, only while the tab is visible.
  const pulse = useQuery({
    queryKey: PULSE_KEY,
    queryFn: coupleApi.pulse,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const { incoming, count } = useApprovals();
  const waterCount = incoming.filter((i) => i.type === 'water').length;
  const proposalCount = incoming.length - waterCount;
  const latestText = [
    waterCount > 0 ? `${waterCount} lượt uống nước` : '',
    proposalCount > 0 ? `${proposalCount} đề xuất` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Page className="home-page" title={`Chào ${me ? shortName(me.user.displayName) : ''} 👋`} subtitle={formatToday()}>
      {couple.isLoading && <Skeleton height={300} />}
      {couple.isError && <ErrorState onRetry={() => void couple.refetch()} />}
      {couple.data && <Hero couple={couple.data} myId={me?.user.id} pulse={pulse.data} />}

      {count > 0 && (
        <Link to="/notifications?filter=approvals" className="attention">
          <span className="icon-tile icon-tile--warning" aria-hidden="true">
            <Icon name="bell" />
          </span>
          <span className="attention__body">
            <span className="attention__title" style={{ display: 'block' }}>
              {count} việc cần bạn duyệt
            </span>
            <span className="attention__meta" style={{ display: 'block' }}>
              {latestText}
            </span>
          </span>
          <Icon name="chevronRight" />
        </Link>
      )}

      {/* Permanent entry points stay separate from the activity cards, including when pulse cannot load. */}
      <section className="home-section" aria-labelledby="home-together">
        <div className="home-section__heading"><h2 id="home-together">Dành cho hai bạn</h2></div>
        <nav className="home-summary-grid" aria-label="Khám phá cùng nhau">
          <Link to="/moments" className="card card--link">
            <div className="row">
              <span className="icon-tile" aria-hidden="true"><Icon name="camera" /></span>
              <div className="grow"><p className="card__title">Khoảnh khắc</p><p className="text-sm text-muted">Lịch chụp và những tấm ảnh của hai bạn</p></div>
              <Icon name="chevronRight" className="text-muted" />
            </div>
          </Link>
          <Link to="/events" className="card card--link">
            <div className="row">
              <span className="icon-tile" aria-hidden="true"><Icon name="calendar" /></span>
              <div className="grow"><p className="card__title">Sự kiện</p><p className="text-sm text-muted">Lên lịch hẹn và lưu ngày đáng nhớ</p></div>
              <Icon name="chevronRight" className="text-muted" />
            </div>
          </Link>
        </nav>
        {pulse.isPending && <p className="text-sm text-muted" role="status">Đang tải hoạt động của hai bạn…</p>}
        {pulse.isError && <ErrorState title="Chưa cập nhật được hoạt động" message={pulse.data ? 'Đang giữ thông tin đã tải trước đó.' : 'Một số hoạt động chưa hiển thị. Thử tải lại nhé.'} onRetry={() => void pulse.refetch()} />}
        <HomeMoment moment={pulse.data?.moment} />
        {pulse.data?.letters && pulse.data.letters.openable > 0 && <LettersCard letters={pulse.data.letters} />}
        <QuestionCard pulse={pulse.data?.question} pulseUpdatedAt={pulse.dataUpdatedAt} />
        {pulse.data?.nextEvent && <UpcomingCard event={pulse.data.nextEvent} />}
      </section>

      <section className="home-section" aria-labelledby="home-everyday">
        <div className="home-section__heading"><h2 id="home-everyday">Nhịp sống chung</h2></div>
        <div className="home-summary-grid">
          <TodaySummary />
          <FinanceCard timezone={me?.user.timezone ?? 'Asia/Ho_Chi_Minh'} />
          {pulse.data?.savings && <SavingsHomeCard goal={pulse.data.savings} />}
          <WalletCard />
        </div>
      </section>
    </Page>
  );
}
