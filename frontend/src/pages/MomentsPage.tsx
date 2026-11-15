import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { GalleryViewer } from '../components/GalleryViewer';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { MOMENT_TODAY_KEY, momentMonthKey, momentsApi, refreshMoments } from '../features/moments/api';
import { canCapture, CaptureButton, MomentPair, MomentRewardStatus, MomentTimer, useMomentNow } from '../features/moments/MomentViews';
import { useCouplePeople } from '../features/questions/useCouplePeople';
import { STORY_FEED_KEY } from '../features/stories/api';
import { ApiRequestError, currentAccessEpoch } from '../lib/apiClient';
import { tokenStore } from '../lib/tokenStore';
import { appLockEpoch } from '../features/appLock/store';
import { dayHeading, formatTime, monthLabel, shiftMonth } from '../lib/format';
import type { MomentDay, MomentSession } from '../lib/types';

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
type OpenPhoto = (urls: string[], index: number) => void;
function StoryButton({ session }: { session: MomentSession }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const post = useMutation({
    mutationFn: async () => {
      const generation = tokenStore.generation(), epoch = currentAccessEpoch(), lock = appLockEpoch();
      await momentsApi.toStory(session);
      return () => mounted.current && tokenStore.isCurrent(generation) && epoch === currentAccessEpoch() && lock === appLockEpoch();
    },
    onSuccess: async (valid) => {
      if (!valid()) return;
      toast.success('Đã đăng lên Story');
      await Promise.all([refreshMoments(qc), qc.invalidateQueries({ queryKey: STORY_FEED_KEY })]);
    },
    onError: async (err) => {
      if (!mounted.current || (err instanceof ApiRequestError && ['SESSION_CHANGED', 'ACCESS_CHANGED'].includes(err.code))) return;
      toast.error(err instanceof ApiRequestError ? err.message : 'Chưa đăng được, thử lại nhé.');
      if (err instanceof ApiRequestError && err.code === 'MOMENT_STORY_EXISTS') await refreshMoments(qc);
    },
  });
  if (session.state !== 'both') return null;
  if (session.storyId) return <Link to={`/stories/${encodeURIComponent(session.storyId)}`} className="btn btn-outline btn-block"><Icon name="bookOpen" size={18} /> Xem trên Story</Link>;
  if (session.legacy || session.scheduleVersion !== 3) return null;
  return <button type="button" className="btn btn-secondary btn-block" disabled={post.isPending} onClick={() => post.mutate()}>
    {post.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="bookOpen" size={18} />} Đăng khoảnh khắc lên Story
  </button>;
}
function SessionPanel({ session, partnerName, onOpenPhoto, highlighted = false }: {
  session: MomentSession; partnerName: string; onOpenPhoto: OpenPhoto; highlighted?: boolean;
}) {
  const now = useMomentNow(session.closesAt, session.rewardEndsAt);
  const open = canCapture(session, now);
  const closed = session.closed || session.scheduleVersion !== 3 || now >= Date.parse(session.closesAt);
  const rewardOpen = now < Date.parse(session.rewardEndsAt);
  const view = closed ? { ...session, closed: true } : session;
  const title = session.legacy ? 'Khoảnh khắc cũ' : session.scheduleVersion === 3 ? 'Khoảnh khắc trong ngày' : `Lượt ${formatTime(session.promptAt)}`;
  return <section className="card mo-today" aria-label={title} aria-current={highlighted ? 'true' : undefined}>
    <div className="row row--between"><h2 className="card__title">{title}</h2>
      {session.state === 'both' && <span className="chip chip--success">Cả hai đã chụp</span>}
      {closed && session.state !== 'both' && <span className="chip">Đã kết thúc</span>}
    </div>
    {!closed && session.state !== 'both' && <MomentTimer rewardEndsAt={session.rewardEndsAt} closesAt={session.closesAt} />}
    <MomentPair day={view} partnerName={partnerName} onOpenPhoto={onOpenPhoto} />
    <MomentRewardStatus session={view} />
    {open && <CaptureButton key={session.sessionId} target={session} closesAt={session.closesAt} rewardEndsAt={session.rewardEndsAt}
      label={rewardOpen ? 'Chụp ngay' : 'Chụp giữ chuỗi'} className={`btn ${rewardOpen ? 'btn-primary' : 'btn-secondary'} btn-lg btn-block`} />}
    {session.state === 'posted' && !closed && <p className="text-sm text-muted">Chờ {partnerName} chụp hôm nay để xem ảnh của nhau và giữ chuỗi.</p>}
    <StoryButton key={session.sessionId} session={session} />
  </section>;
}
function DayPanel({ day, partnerName, onOpenPhoto, selectedSession }: { day: MomentDay; partnerName: string; onOpenPhoto: OpenPhoto; selectedSession?: string | null }) {
  const now = useMomentNow(day.sessions.find((s) => !s.closed)?.closesAt);
  const active = day.sessions.some((s) => !s.closed && now < Date.parse(s.closesAt));
  return <div className="stack">
    {day.scheduleVersion !== 3 && <p className="text-sm text-muted">Ngày theo lịch cũ chỉ để xem; ảnh và Story vẫn được giữ. Lịch một lần mỗi ngày bắt đầu từ ngày địa phương tiếp theo.</p>}
    {day.scheduleVersion === 3 && !active && <div className="card"><h2 className="card__title">{day.sessions.length ? 'Ngày chụp đã kết thúc' : 'Chưa đến giờ chụp hôm nay'}</h2><p className="text-sm text-muted">Một thông báo bất ngờ mỗi ngày. Cả hai chụp trong 30 phút đầu để nhận tổng 40 Xu (20 Xu mỗi người); sau đó vẫn chụp đến hết ngày để giữ chuỗi.</p></div>}
    {selectedSession && !day.sessions.some((s) => s.sessionId === selectedSession) && <p className="text-sm text-muted">Lượt này chưa có hoặc chưa mở. Không thể chụp từ liên kết này.</p>}
    {day.sessions.filter((s) => !selectedSession || s.sessionId === selectedSession).map((s) => <SessionPanel key={s.sessionId} session={s} partnerName={partnerName} onOpenPhoto={onOpenPhoto} highlighted={s.sessionId === selectedSession} />)}
  </div>;
}
function MonthGrid({ month, today, days, onPick }: { month: string; today: string; days: MomentDay[]; onPick: (d: MomentDay) => void }) {
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.localDate, d]));
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  return <div className="mo-cal" aria-label={monthLabel(month)}>
    {WEEKDAYS.map((w) => <span key={w} className="mo-cal__wd" aria-hidden="true">{w}</span>)}
    {cells.map((date, i) => {
      if (!date) return <span key={`e${i}`} aria-hidden="true" />;
      const day = byDate.get(date);
      const both = day?.sessions.some((s) => s.state === 'both');
      const thumbnail = day?.sessions.find((s) => s.state === 'both') ?? day?.sessions.find((s) => s.mine || s.partner.posted);
      const n = Number(date.slice(8));
      return <button key={date} type="button" className={`mo-cal__day${date === today ? ' mo-cal__day--today' : ''}${both ? ' mo-cal__day--both' : ''}`}
        disabled={!day?.sessions.length} aria-label={`Ngày ${n}: ${both ? 'cả hai đã chụp' : day?.scheduleVersion === 3 ? (day.sessions.length ? 'khoảnh khắc đã mở' : 'chưa mở') : `${day?.sessions.length ?? 0} lượt cũ`}`} onClick={() => day && onPick(day)}>
        <span className="mo-cal__num">{n}</span>
        {thumbnail && <span className="mo-cal__thumbs" aria-hidden="true">
          {thumbnail.mine ? <img src={thumbnail.mine.url} alt="" loading="lazy" decoding="async" /> : <span className="mo-cal__blank" />}
          {thumbnail.partner.photo ? <img src={thumbnail.partner.photo.url} alt="" loading="lazy" decoding="async" /> : <span className={`mo-cal__blank${thumbnail.partner.posted ? ' mo-cal__blank--locked' : ''}`}>{thumbnail.partner.posted ? 'Khóa' : ''}</span>}
        </span>}
        {!!day?.sessions.length && !thumbnail && <span className="mo-cal__dot" aria-hidden="true" />}
      </button>;
    })}
  </div>;
}
export function MomentsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { partnerName, today: localToday } = useCouplePeople();
  const linkedDate = search.get('date');
  const validDate = linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate) ? linkedDate : null;
  const selectedSession = search.get('session');
  const todayQ = useQuery({ queryKey: MOMENT_TODAY_KEY, queryFn: momentsApi.today, staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const [month, setMonth] = useState(validDate?.slice(0, 7) ?? localToday.slice(0, 7));
  const monthQ = useQuery({ queryKey: momentMonthKey(month), queryFn: () => momentsApi.month(month), staleTime: 0 });
  const [picked, setPicked] = useState<string | null>(validDate);
  useEffect(() => { if (validDate) { setMonth(validDate.slice(0, 7)); setPicked(validDate); } }, [validDate]);
  const [gallery, setGallery] = useState<{ urls: string[]; index: number } | null>(null);
  const openPhoto: OpenPhoto = (urls, index) => setGallery({ urls, index: Math.max(0, index) });
  const data = monthQ.data;
  const today = data?.today ?? localToday;
  const pickedDay = picked ? (picked === todayQ.data?.localDate ? todayQ.data : data?.days.find((d) => d.localDate === picked)) : undefined;
  const streak = data?.streak;
  const closeDay = () => { setPicked(null); if (validDate) setSearch({}, { replace: true }); };
  return <Page title="Khoảnh khắc" subtitle="Một lần mỗi ngày · 30 phút đầu nhận thưởng" onBack={() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1); else navigate('/', { replace: true });
  }}>
    {todayQ.isLoading && <Skeleton height={260} />}
    {todayQ.isError && <ErrorState onRetry={() => void todayQ.refetch()} />}
    {todayQ.data && <DayPanel day={todayQ.data} partnerName={partnerName} onOpenPhoto={openPhoto} />}
    {streak && <div className="card mo-streak"><span className="grow"><span className="mo-streak__num">{streak.current > 0 ? `${streak.current} ngày liên tiếp` : 'Chưa có chuỗi ngày nào'}</span>
      <span className="text-sm text-muted mo-streak__hint">Cả hai chụp trong ngày là giữ chuỗi, kể cả sau hạn thưởng. Chỉ hai ảnh đúng giờ mới đủ điều kiện nhận 40 Xu.{streak.best > streak.current ? ` Kỷ lục ${streak.best} ngày.` : ''}</span>
    </span></div>}
    <section className="card mo-month" aria-labelledby="mo-month-title"><div className="mo-month__head">
      <button type="button" className="icon-btn" aria-label="Tháng trước" disabled={!data || month <= data.minMonth} onClick={() => setMonth((m) => shiftMonth(m, -1))}><Icon name="chevronLeft" /></button>
      <h2 id="mo-month-title" className="card__title">{monthLabel(month)}</h2>
      <button type="button" className="icon-btn" aria-label="Tháng sau" disabled={month >= today.slice(0, 7)} onClick={() => setMonth((m) => shiftMonth(m, 1))}><Icon name="chevronRight" /></button>
    </div>
      {monthQ.isLoading && <Skeleton height={300} />}
      {monthQ.isError && <ErrorState onRetry={() => void monthQ.refetch()} />}
      {data && <MonthGrid month={month} today={today} days={data.days} onPick={(d) => setPicked(d.localDate)} />}
      {data && data.days.every((d) => d.sessions.every((s) => !s.mine && !s.partner.posted)) && <p className="text-sm text-muted center">Tháng này chưa có ảnh nào.</p>}
    </section>
    <BottomSheet open={Boolean(pickedDay)} title={pickedDay ? dayHeading(pickedDay.localDate, today) : ''} onClose={closeDay}>
      {pickedDay && <DayPanel day={pickedDay} partnerName={partnerName} onOpenPhoto={openPhoto} selectedSession={picked === validDate ? selectedSession : undefined} />}
    </BottomSheet>
    <GalleryViewer urls={gallery?.urls ?? []} index={gallery ? gallery.index : null} onClose={() => setGallery(null)} />
  </Page>;
}
