import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError, currentAccessEpoch } from '../../lib/apiClient';
import { formatTime } from '../../lib/format';
import { tokenStore } from '../../lib/tokenStore';
import type { MomentDay, MomentPhoto, MomentSession, MomentTarget } from '../../lib/types';
import { appLockEpoch, appLockState, isAppLocked } from '../appLock/store';
import { MAX_MOMENT_CAPTION, isMomentPhotoOnTime, lateText, mmss, momentsApi, refreshMoments, uploadMomentPhoto } from './api';

/** Both deadlines update immediately, including after background/focus resume. */
export function useMomentNow(closesAt?: string | null, rewardEndsAt?: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timers = [closesAt, rewardEndsAt].flatMap((deadline) => {
      const end = deadline ? Date.parse(deadline) : 0;
      return end > Date.now() ? [window.setTimeout(update, Math.min(end - Date.now(), 2_147_483_647))] : [];
    });
    const interval = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer)); window.clearInterval(interval);
      window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update);
    };
  }, [closesAt, rewardEndsAt]);
  return now;
}
export function canCapture(session: Pick<MomentSession, 'state' | 'closesAt' | 'promptAt' | 'closed' | 'legacy' | 'scheduleVersion'>, now = Date.now()): boolean {
  return session.scheduleVersion === 3 && !session.legacy && !session.closed && session.state === 'open'
    && now >= Date.parse(session.promptAt) && now < Date.parse(session.closesAt);
}

/** Freeze session and account BEFORE opening the native camera. Never reuse a capture for another session. */
export function CaptureButton({ target, closesAt, rewardEndsAt, className, label = 'Chụp ngay', onPosted }: {
  target: MomentTarget; closesAt: string; rewardEndsAt: string; className: string; label?: string; onPosted?: (day: MomentDay) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [capture, setCapture] = useState<{ file: File; target: MomentTarget; valid: () => boolean } | null>(null);
  const pending = useRef<{ target: MomentTarget; valid: () => boolean } | null>(null);
  const mounted = useRef(true);
  const identity = `${target.localDate}/${target.sessionId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const now = useMomentNow(closesAt);
  const open = now < Date.parse(closesAt);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setCapture(null); pending.current = null; }, [identity, open]);
  function pick() {
    if (Date.now() >= Date.parse(closesAt)) return;
    const generation = tokenStore.generation();
    // Native cameras may hide the page. A no-PIN resume preserves this mounted draft;
    // an actual lock discards it. Mutation responses use their own stricter epochs below.
    pending.current = { target: { localDate: target.localDate, sessionId: target.sessionId }, valid: () => mounted.current && currentIdentity.current === identity
      && tokenStore.isCurrent(generation) && !appLockState().discard
      && Date.now() < Date.parse(closesAt) };
    fileRef.current?.click();
  }
  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    const started = pending.current;
    if (file?.type.startsWith('image/') && started?.valid()) setCapture({ file, ...started });
  }
  if (!open) return null;
  return <>
    <button type="button" className={className} onClick={pick}><Icon name="camera" size={20} /> {label}</button>
    <input ref={fileRef} type="file" accept="image/*" capture hidden aria-label="Chụp ảnh Khoảnh khắc" onChange={onPick} />
    {capture && <PostMomentSheet key={`${identity}-${capture.file.name}-${capture.file.lastModified}-${capture.file.size}`}
      file={capture.file} target={capture.target} rewardEndsAt={rewardEndsAt} closesAt={closesAt} valid={capture.valid} onRetake={pick} onClose={() => setCapture(null)}
      onPosted={(day) => { if (capture.valid()) { setCapture(null); onPosted?.(day); } }} />}
  </>;
}
export function PostMomentSheet({ file, target, rewardEndsAt, closesAt, valid, onRetake, onClose, onPosted }: {
  file: File; target: MomentTarget; rewardEndsAt: string; closesAt: string; valid: () => boolean; onRetake: () => void; onClose: () => void; onPosted: (day: MomentDay) => void;
}) {
  const now = useMomentNow(closesAt, rewardEndsAt);
  const rewardOpen = now < Date.parse(rewardEndsAt);
  const qc = useQueryClient();
  const toast = useToast();
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const uploaded = useRef<{ key: string; width: number; height: number } | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const active = () => mounted.current && valid();
  useEffect(() => {
    mounted.current = true;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => { mounted.current = false; URL.revokeObjectURL(url); };
  }, [file]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || !active() || isAppLocked() || document.visibilityState !== 'visible') return;
    const access = currentAccessEpoch(), lock = appLockEpoch();
    const currentAttempt = () => active() && access === currentAccessEpoch() && lock === appLockEpoch() &&
      !isAppLocked() && document.visibilityState === 'visible';
    const assertActive = () => { if (!currentAttempt()) throw new ApiRequestError(409, 'MOMENT_CLOSED', 'Lượt chụp hoặc quyền truy cập đã thay đổi.'); };
    submitting.current = true; setBusy(true); setError(null);
    try {
      if (!uploaded.current) {
        setStatus('Đang tải ảnh…');
        const photo = await uploadMomentPhoto(file, target, assertActive);
        assertActive(); uploaded.current = photo;
      }
      assertActive(); setStatus('Đang đăng…');
      const day = await momentsApi.post({ ...uploaded.current, ...target, caption: caption.trim() });
      if (!currentAttempt()) return;
      toast.success('Đã đăng Khoảnh khắc');
      await refreshMoments(qc);
      if (currentAttempt()) onPosted(day);
    } catch (err) {
      if (!currentAttempt()) return;
      const message = err instanceof Error ? err.message : 'Chưa đăng được, thử lại nhé.';
      setError(message);
      if (err instanceof ApiRequestError && ['MOMENT_ALREADY_POSTED', 'MOMENT_NOT_YET', 'MOMENT_CLOSED', 'MOMENT_LEGACY_READ_ONLY'].includes(err.code)) {
        toast.error(message);
        await refreshMoments(qc);
        if (currentAttempt()) onClose();
      }
    } finally {
      submitting.current = false;
      if (active()) { setBusy(false); setStatus(null); }
    }
  }
  return <BottomSheet open title="Khoảnh khắc của bạn" onClose={() => !busy && onClose()}>
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="mo-preview">{preview && <img src={preview} alt="Ảnh bạn vừa chụp" />}</div>
      <label className="field"><span className="field__label">Một dòng (tuỳ chọn)</span>
        <input className="input" value={caption} maxLength={MAX_MOMENT_CAPTION} onChange={(e) => setCaption(e.target.value)} placeholder="Bạn đang làm gì?" disabled={busy} />
        <span className="char-count">{caption.length}/{MAX_MOMENT_CAPTION}</span>
      </label>
      <p className="text-sm text-muted">Mỗi người một ảnh mỗi ngày. Cả hai chụp trong 30 phút đầu để nhận tổng 40 Xu (20 Xu mỗi người) qua nhiệm vụ. Chụp trong ngày để xem ảnh của nhau và giữ chuỗi.</p>
      <p className="text-sm text-muted" role="status">{rewardOpen
        ? 'Ảnh được tính đúng giờ khi máy chủ nhận bài đăng trước hạn thưởng. Ảnh xem trước vẫn được giữ sau hạn này.'
        : 'Đã hết thời gian nhận thưởng — vẫn chụp được hôm nay để giữ chuỗi. Ảnh xem trước chỉ đóng khi hết ngày.'}</p>
      {status && <p className="composer__status" role="status">{status}</p>}
      {error && <p className="form-feedback" role="alert">{error}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => active() && onRetake()}>Chụp lại</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" aria-hidden="true" />}Đăng</button>
      </div>
    </form>
  </BottomSheet>;
}
export function MomentTimer({ rewardEndsAt, closesAt }: { rewardEndsAt: string; closesAt: string }) {
  const now = useMomentNow(closesAt, rewardEndsAt);
  const left = Date.parse(rewardEndsAt) - now;
  if (now >= Date.parse(closesAt)) return <p className="text-sm text-muted">Ngày chụp đã kết thúc</p>;
  return left > 0 ? <p className="mo-timer" role="timer" aria-live="off">Còn <strong className="num">{mmss(left)}</strong> để cả hai chụp nhận tổng 40 Xu · 20 Xu mỗi người</p>
    : <p className="text-sm text-muted" role="status">Đã hết thời gian nhận thưởng — vẫn chụp được hôm nay để giữ chuỗi.</p>;
}
function photoMeta(p: MomentPhoto, session: MomentSession): string {
  const late = session.scheduleVersion === 3
    ? (isMomentPhotoOnTime(session, p.postedAt) ? null : lateText(p.lateMin) ?? 'Sau hạn thưởng')
    : lateText(p.lateMin);
  return late ? `${formatTime(p.postedAt)} · ${late}` : `${formatTime(p.postedAt)} · Đúng giờ`;
}
/** Posting together preserves the streak; only two on-time posts unlock the quest reward. */
export function MomentRewardStatus({ session }: { session: MomentSession }) {
  const now = useMomentNow(session.closesAt, session.rewardEndsAt);
  if (session.scheduleVersion !== 3) return null;
  const late = (session.mine && !isMomentPhotoOnTime(session, session.mine.postedAt))
    || (session.partner.postedAt && !isMomentPhotoOnTime(session, session.partner.postedAt));
  if (session.state === 'both') return <p className="text-sm text-muted" role="status">{late
    ? 'Cả hai đã chụp để giữ chuỗi. Có ảnh sau hạn thưởng nên hôm nay không đủ điều kiện nhận 40 Xu.'
    : session.closed || now >= Date.parse(session.closesAt)
      ? 'Cả hai đã chụp đúng giờ, giữ chuỗi và đủ điều kiện thưởng 40 Xu trong ngày này.'
      : 'Cả hai đã chụp đúng giờ và giữ chuỗi. Đủ điều kiện nhận tổng 40 Xu (20 Xu mỗi người) trong Nhiệm vụ.'}</p>;
  if (session.closed || now >= Date.parse(session.closesAt)) return <p className="text-sm text-muted">Ngày này chưa đủ hai ảnh để giữ chuỗi hoặc nhận thưởng.</p>;
  if (late) return <p className="text-sm text-muted">Có ảnh sau hạn thưởng nên hôm nay không đủ điều kiện nhận 40 Xu. Cả hai vẫn có thể chụp trước hết ngày để giữ chuỗi.</p>;
  if (session.mine && now >= Date.parse(session.rewardEndsAt)) return <p className="text-sm text-muted">Bạn đã chụp đúng giờ, nhưng cần cả hai đăng trước hạn thưởng để nhận 40 Xu. Cả hai chụp trong ngày vẫn giữ chuỗi.</p>;
  return null;
}
/** Privacy is per session; the server never supplies the partner photo without my post in this same session. */
export function MomentPair({ day, partnerName, onOpenPhoto, size = 'lg' }: {
  day: MomentSession; partnerName: string; onOpenPhoto?: (urls: string[], index: number) => void; size?: 'lg' | 'md';
}) {
  const urls = [day.mine?.url, day.partner.photo?.url].filter((u): u is string => Boolean(u));
  const daily = day.scheduleVersion === 3;
  const tile = (who: string, photo: MomentPhoto | null, text: string) => <figure className="mo-tile">
    {photo ? <button type="button" className="mo-tile__photo" onClick={() => onOpenPhoto?.(urls, urls.indexOf(photo.url))} aria-label={`Xem lớn ảnh của ${who}`}>
      <img src={photo.url} alt={`Ảnh của ${who}`} loading="lazy" />
    </button> : <div className="mo-tile__empty"><span className="mo-tile__text">{text}</span></div>}
    <figcaption className="mo-tile__cap"><span className="mo-tile__who">{who}</span>
      {photo && <span className={`mo-tile__meta${(daily ? !isMomentPhotoOnTime(day, photo.postedAt) : photo.lateMin > 0) ? ' mo-tile__meta--late' : ''}`}>{photoMeta(photo, day)}</span>}
      {photo?.caption && <span className="mo-tile__caption">“{photo.caption}”</span>}
    </figcaption>
  </figure>;
  return <div className={`mo-pair mo-pair--${size}`}>
    {tile('Bạn', day.mine, day.closed ? (daily ? 'Bạn bỏ lỡ ngày này' : 'Bạn bỏ lỡ lượt này') : 'Bạn chưa chụp')}
    {tile(partnerName, day.partner.photo, day.partner.posted
      ? `${partnerName} đã chụp · ${day.closed ? `Ảnh được giữ kín vì bạn bỏ lỡ ${daily ? 'ngày' : 'lượt'} này` : daily ? 'Chụp hôm nay để xem' : 'Chụp cùng lượt để xem'}`
      : `${partnerName} ${day.closed ? `bỏ lỡ ${daily ? 'ngày' : 'lượt'} này` : 'chưa chụp'}`)}
  </div>;
}
