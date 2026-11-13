import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { GalleryViewer } from '../components/GalleryViewer';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { MOMENT_TODAY_KEY, momentMonthKey, momentsApi, refreshMoments } from '../features/moments/api';
import { CaptureButton, MomentPair, MomentTimer } from '../features/moments/MomentViews';
import { useCouplePeople } from '../features/questions/useCouplePeople';
import { STORY_FEED_KEY } from '../features/stories/api';
import { ApiRequestError } from '../lib/apiClient';
import { dayHeading, monthLabel, shiftMonth } from '../lib/format';
import type { MomentDay } from '../lib/types';

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

type OpenPhoto = (urls: string[], index: number) => void;

/** "Đăng lên Story" (both photos, once) or "Xem trên Story". */
function StoryButton({ day }: { day: MomentDay }) {
  const qc = useQueryClient();
  const toast = useToast();
  const post = useMutation({
    mutationFn: () => momentsApi.toStory(day.localDate),
    onSuccess: async () => {
      toast.success('Đã đăng lên Story 💞');
      await Promise.all([refreshMoments(qc), qc.invalidateQueries({ queryKey: STORY_FEED_KEY })]);
    },
    onError: async (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Chưa đăng được, thử lại nhé.');
      if (err instanceof ApiRequestError && err.code === 'MOMENT_STORY_EXISTS') await refreshMoments(qc);
    },
  });
  if (day.state !== 'both') return null;
  if (day.storyId) {
    return (
      <Link to={`/stories/${encodeURIComponent(day.storyId)}`} className="btn btn-outline btn-block">
        <Icon name="bookOpen" size={18} /> Xem trên Story
      </Link>
    );
  }
  return (
    <button type="button" className="btn btn-secondary btn-block" disabled={post.isPending} onClick={() => post.mutate()}>
      {post.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="bookOpen" size={18} />} Đăng lên Story
    </button>
  );
}

/** Today: not yet (no time shown), open (camera + 10-minute countdown), posted (waiting for the partner), both. */
function TodayPanel({ day, partnerName, onOpenPhoto }: { day: MomentDay; partnerName: string; onOpenPhoto: OpenPhoto }) {
  if (day.state === 'waiting') {
    return (
      <section className="card mo-today" aria-label="Khoảnh khắc hôm nay">
        <p className="mo-today__art" aria-hidden="true">
          ⏳
        </p>
        <h2 className="card__title center">Hôm nay chưa tới giờ Khoảnh khắc</h2>
        <p className="text-sm text-muted center">Mỗi ngày một giờ bất ngờ trong khoảng 9:00 – 21:00. Tới giờ, app sẽ báo cả hai để cùng chụp.</p>
      </section>
    );
  }
  return (
    <section className="card mo-today" aria-label="Khoảnh khắc hôm nay">
      <div className="row row--between">
        <h2 className="card__title">Hôm nay</h2>
        {day.state === 'both' && <span className="chip chip--success">Cả hai đã chụp</span>}
        {day.state === 'posted' && <span className="chip">Chờ {partnerName}</span>}
      </div>
      {day.state === 'open' && <MomentTimer windowEndsAt={day.windowEndsAt} />}
      <MomentPair day={day} partnerName={partnerName} onOpenPhoto={onOpenPhoto} />
      {day.state === 'open' && <CaptureButton className="btn btn-primary btn-lg btn-block" />}
      {day.state === 'posted' && <p className="text-sm text-muted">Khi {partnerName} chụp xong, ảnh sẽ hiện ở đây.</p>}
      <StoryButton day={day} />
    </section>
  );
}

function dayLabel(d: MomentDay | undefined): string {
  if (!d) return 'không có Khoảnh khắc';
  switch (d.state) {
    case 'both':
      return 'cả hai đã chụp';
    case 'posted':
      return d.closed ? 'chỉ bạn chụp' : 'bạn đã chụp';
    case 'missed':
      return d.partner.posted ? 'bạn bỏ lỡ, người ấy đã chụp' : 'cả hai bỏ lỡ';
    case 'open':
      return 'đang mở';
    case 'waiting':
      return 'chưa tới giờ';
  }
}

/** Month grid (Monday first): each day with its two photos as a small pair; tap a day to see it large. */
function MonthGrid({ month, today, days, onPick }: { month: string; today: string; days: MomentDay[]; onPick: (d: MomentDay) => void }) {
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.localDate, d]));
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];

  return (
    <div className="mo-cal" aria-label={monthLabel(month)}>
      {WEEKDAYS.map((w) => (
        <span key={w} className="mo-cal__wd" aria-hidden="true">
          {w}
        </span>
      ))}
      {cells.map((date, i) => {
        if (!date) return <span key={`e${i}`} aria-hidden="true" />;
        const d = byDate.get(date);
        const n = Number(date.slice(8));
        const usable = d && d.state !== 'waiting';
        const thumbs = d && (d.mine || d.partner.posted);
        return (
          <button
            key={date}
            type="button"
            className={`mo-cal__day${date === today ? ' mo-cal__day--today' : ''}${d?.state === 'both' ? ' mo-cal__day--both' : ''}`}
            disabled={!usable}
            aria-label={`Ngày ${n}: ${dayLabel(d)}`}
            onClick={() => d && onPick(d)}
          >
            <span className="mo-cal__num">{n}</span>
            {thumbs && d && (
              <span className="mo-cal__thumbs" aria-hidden="true">
                {d.mine ? <img src={d.mine.url} alt="" loading="lazy" decoding="async" /> : <span className="mo-cal__blank" />}
                {d.partner.photo ? (
                  <img src={d.partner.photo.url} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className={`mo-cal__blank${d.partner.posted ? ' mo-cal__blank--locked' : ''}`}>{d.partner.posted ? '🔒' : ''}</span>
                )}
              </span>
            )}
            {d && !thumbs && d.closed && <span className="mo-cal__dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/** /moments — "Khoảnh khắc đôi" (CP6): today, the streak, and a month calendar of paired photos. */
export function MomentsPage() {
  const navigate = useNavigate();
  const { partnerName, today: localToday } = useCouplePeople();
  const todayQ = useQuery({ queryKey: MOMENT_TODAY_KEY, queryFn: momentsApi.today, staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const [month, setMonth] = useState(localToday.slice(0, 7));
  const monthQ = useQuery({ queryKey: momentMonthKey(month), queryFn: () => momentsApi.month(month), staleTime: 0 });
  const [picked, setPicked] = useState<string | null>(null);
  const [gallery, setGallery] = useState<{ urls: string[]; index: number } | null>(null);
  const openPhoto: OpenPhoto = (urls, index) => setGallery({ urls, index: Math.max(0, index) });

  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/', { replace: true });
  };

  const data = monthQ.data;
  const today = data?.today ?? localToday;
  const currentMonth = today.slice(0, 7);
  const pickedDay = picked ? (picked === todayQ.data?.localDate ? todayQ.data : data?.days.find((d) => d.localDate === picked)) : undefined;
  const streak = data?.streak;

  return (
    <Page title="Khoảnh khắc" subtitle="Mỗi ngày một tấm, cùng một lúc" onBack={goBack}>
      {todayQ.isLoading && <Skeleton height={260} />}
      {todayQ.isError && <ErrorState onRetry={() => void todayQ.refetch()} />}
      {todayQ.data && <TodayPanel day={todayQ.data} partnerName={partnerName} onOpenPhoto={openPhoto} />}

      {streak && (
        <div className="card mo-streak">
          <span className="mo-streak__art" aria-hidden="true">
            🔥
          </span>
          <span className="grow">
            <span className="mo-streak__num">
              {streak.current > 0 ? `${streak.current} ngày liên tiếp` : 'Chưa có chuỗi ngày nào'}
            </span>
            <span className="text-sm text-muted mo-streak__hint">
              {streak.current > 0 ? 'cả hai cùng chụp' : 'Hôm nay cả hai cùng chụp để bắt đầu chuỗi nhé!'}
              {streak.best > streak.current ? ` · Kỷ lục ${streak.best} ngày` : ''}
            </span>
          </span>
        </div>
      )}

      <section className="card mo-month" aria-labelledby="mo-month-title">
        <div className="mo-month__head">
          <button
            type="button"
            className="icon-btn"
            aria-label="Tháng trước"
            disabled={!data || month <= data.minMonth}
            onClick={() => setMonth((x) => shiftMonth(x, -1))}
          >
            <Icon name="chevronLeft" />
          </button>
          <h2 id="mo-month-title" className="card__title">
            {monthLabel(month)}
          </h2>
          <button type="button" className="icon-btn" aria-label="Tháng sau" disabled={month >= currentMonth} onClick={() => setMonth((x) => shiftMonth(x, 1))}>
            <Icon name="chevronRight" />
          </button>
        </div>
        {monthQ.isLoading && <Skeleton height={300} />}
        {monthQ.isError && <ErrorState onRetry={() => void monthQ.refetch()} />}
        {data && <MonthGrid month={month} today={today} days={data.days} onPick={(d) => setPicked(d.localDate)} />}
        {data && data.days.every((d) => !d.mine && !d.partner.posted) && (
          <p className="text-sm text-muted center">Tháng này chưa có ảnh nào. Mỗi ngày có một Khoảnh khắc, cả hai cùng chụp nhé.</p>
        )}
      </section>

      <BottomSheet open={Boolean(pickedDay)} title={pickedDay ? dayHeading(pickedDay.localDate, today) : ''} onClose={() => setPicked(null)}>
        {pickedDay && (
          <div className="stack">
            <MomentPair day={pickedDay} partnerName={partnerName} onOpenPhoto={openPhoto} />
            {pickedDay.state === 'missed' && (
              <p className="text-sm text-muted">{pickedDay.partner.posted ? `Hôm đó bạn không chụp nên ảnh của ${partnerName} vẫn được giữ kín.` : 'Hôm đó hai bạn không chụp.'}</p>
            )}
            {pickedDay.state === 'open' && <CaptureButton className="btn btn-primary btn-block" onPosted={() => setPicked(null)} />}
            <StoryButton day={pickedDay} />
          </div>
        )}
      </BottomSheet>
      <GalleryViewer urls={gallery?.urls ?? []} index={gallery ? gallery.index : null} onClose={() => setGallery(null)} />
    </Page>
  );
}
