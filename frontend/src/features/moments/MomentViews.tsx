import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError, currentAccessEpoch } from '../../lib/apiClient';
import { formatTime } from '../../lib/format';
import { tokenStore } from '../../lib/tokenStore';
import type { MomentDay, MomentPhoto, MomentSession, MomentTarget } from '../../lib/types';
import { appLockEpoch, appLockState, isAppLocked } from '../appLock/store';
import { cacheConfirmedMoment, isConfirmedMoment, isUncertainMomentPost, MAX_MOMENT_CAPTION, isMomentPhotoOnTime, lateText, mmss, momentReceiptKey, momentsApi, refreshMoments, uploadMomentPhoto } from './api';
import type { MomentPostReceipt, MomentPostResult, MomentRewardSummary } from './api';

/** Observe only the exact saved receipt; it cannot unlock signed photos or prove payment. */
function useSavedMoment(target: MomentTarget): boolean {
  const receipt = useQuery<MomentPostReceipt | null>({
    queryKey: momentReceiptKey(target), queryFn: () => null, enabled: false,
  }).data;
  return !!receipt && isConfirmedMoment(receipt, target);
}

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
export function CaptureButton({ target, closesAt, rewardEndsAt, className, label = 'Chụp ngay', onPosted, available = true, reward, onPendingChange }: {
  target: MomentTarget; closesAt: string; rewardEndsAt: string; className: string; label?: string; available?: boolean; reward?: MomentRewardSummary;
  onPosted?: (day?: MomentDay) => void; onPendingChange?: (pending: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [capture, setCapture] = useState<{ file: File; target: MomentTarget; valid: () => boolean } | null>(null);
  const pending = useRef<{ target: MomentTarget; valid: () => boolean } | null>(null);
  const mounted = useRef(true);
  const pendingChange = useRef(onPendingChange);
  pendingChange.current = onPendingChange;
  useEffect(() => { pendingChange.current?.(!!capture); }, [!!capture]);
  useEffect(() => () => pendingChange.current?.(false), []);
  const identity = `${target.localDate}/${target.sessionId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const now = useMomentNow(closesAt);
  const saved = useSavedMoment(target);
  const open = available && !saved && now < Date.parse(closesAt);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setCapture(null); pending.current = null; }, [identity]);
  function pick() {
    if (!open || Date.now() >= Date.parse(closesAt)) return;
    const generation = tokenStore.generation();
    // Native cameras may hide the page. A no-PIN resume preserves this mounted draft;
    // an actual lock discards it. Mutation responses use their own stricter epochs below.
    pending.current = { target: { localDate: target.localDate, sessionId: target.sessionId }, valid: () => mounted.current && currentIdentity.current === identity
      && tokenStore.isCurrent(generation) && !appLockState().discard };
    fileRef.current?.click();
  }
  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    const started = pending.current;
    if (file?.type.startsWith('image/') && started?.valid() && Date.now() < Date.parse(closesAt)) setCapture({ file, ...started });
  }
  if (!open && !capture) return null;
  return <>
    {open && <button type="button" className={className} onClick={pick}><Icon name="camera" size={20} /> {label}</button>}
    <input ref={fileRef} type="file" accept="image/*" capture hidden aria-label="Chụp ảnh Khoảnh khắc" onChange={onPick} />
    {capture && <PostMomentSheet key={`${identity}-${capture.file.name}-${capture.file.lastModified}-${capture.file.size}`}
      file={capture.file} target={capture.target} rewardEndsAt={rewardEndsAt} closesAt={closesAt} reward={reward} valid={capture.valid} onRetake={pick} onClose={() => setCapture(null)}
      onPosted={(day) => { if (capture.valid()) { setCapture(null); onPosted?.(day); } }} />}
  </>;
}
export function PostMomentSheet({ file, target, rewardEndsAt, closesAt, valid, onRetake, onClose, onPosted, reward }: {
  file: File; target: MomentTarget; rewardEndsAt: string; closesAt: string; reward?: MomentRewardSummary;
  valid: () => boolean; onRetake: () => void; onClose: () => void; onPosted: (day?: MomentDay) => void;
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
  // Set BEFORE sending. Even a hidden-page/access-epoch rejection may have committed.
  const uncertain = useRef(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const generation = useRef(tokenStore.generation());
  const request = useRef<AbortController | null>(null);
  const active = () => mounted.current && valid() && tokenStore.isCurrent(generation.current);
  useEffect(() => {
    mounted.current = true;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => { mounted.current = false; request.current?.abort(); URL.revokeObjectURL(url); };
  }, [file]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || !active() || isAppLocked() || document.visibilityState !== 'visible') return;
    const access = currentAccessEpoch(), lock = appLockEpoch();
    const currentAttempt = () => active() && access === currentAccessEpoch() && lock === appLockEpoch() &&
      !isAppLocked() && document.visibilityState === 'visible';
    const assertActive = () => { if (!currentAttempt()) throw new ApiRequestError(409, 'ACCESS_CHANGED', 'Lượt chụp hoặc quyền truy cập đã thay đổi.'); };
    const assertCaptureOpen = () => {
      assertActive();
      if (Date.now() >= Date.parse(closesAt)) throw new ApiRequestError(409, 'MOMENT_CLOSED', 'Ngày chụp đã kết thúc.');
    };
    const controller = new AbortController();
    request.current = controller;
    const finish = (result: MomentPostResult) => {
      if (!currentAttempt() || !isConfirmedMoment(result, target)) return false;
      cacheConfirmedMoment(qc, target, result);
      toast.success('Đã lưu Khoảnh khắc');
      // Do not await refetch, URL signing, rewards, or realtime to dismiss the composer.
      onPosted('sessions' in result ? result : undefined);
      void refreshMoments(qc, target).catch(() => undefined);
      return true;
    };
    const checkSaved = async () => {
      setStatus('Đang kiểm tra ảnh đã lưu…');
      try {
        const day = await momentsApi.reconcile(target, controller.signal);
        if (!currentAttempt()) return;
        if (day && finish(day)) return;
      } catch { if (!currentAttempt()) return; }
      setError('Chưa xác nhận được ảnh đã lưu. Ảnh tải lên vẫn được giữ; hãy kiểm tra lại, không đăng lại.');
    };
    submitting.current = true; setBusy(true); setError(null);
    try {
      if (uncertain.current) { await checkSaved(); return; }
      assertCaptureOpen();
      if (!uploaded.current) {
        setStatus('Đang tải ảnh…');
        const photo = await uploadMomentPhoto(file, target, assertCaptureOpen, controller.signal);
        assertCaptureOpen(); uploaded.current = photo;
      }
      assertCaptureOpen(); setStatus('Đang đăng…');
      uncertain.current = true; setNeedsCheck(true);
      try {
        const result = await momentsApi.post({ ...uploaded.current, ...target, caption: caption.trim() }, controller.signal);
        if (!currentAttempt()) return;
        if (!finish(result)) await checkSaved();
      } catch (err) {
        if (!currentAttempt()) return;
        if (isUncertainMomentPost(err)) await checkSaved();
        else { uncertain.current = false; setNeedsCheck(false); throw err; }
      }
    } catch (err) {
      if (!currentAttempt()) return;
      const alreadyPosted = err instanceof ApiRequestError && err.code === 'MOMENT_ALREADY_POSTED';
      if (alreadyPosted) {
        uncertain.current = true; setNeedsCheck(true); await checkSaved();
      } else setError(err instanceof Error ? err.message : 'Chưa đăng được, thử lại nhé.');
    } finally {
      submitting.current = false;
      if (request.current === controller) request.current = null;
      if (active()) { setBusy(false); setStatus(null); }
    }
  }
  return <BottomSheet open title="Khoảnh khắc của bạn" onClose={() => !busy && onClose()}>
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="mo-preview">{preview && <img src={preview} alt="Ảnh bạn vừa chụp" />}</div>
      <label className="field"><span className="field__label">Một dòng (tuỳ chọn)</span>
        <input className="input" value={caption} maxLength={MAX_MOMENT_CAPTION} onChange={(e) => setCaption(e.target.value)} placeholder="Bạn đang làm gì?" disabled={busy || needsCheck} />
        <span className="char-count">{caption.length}/{MAX_MOMENT_CAPTION}</span>
      </label>
      <p className="text-sm text-muted">Mỗi người một ảnh mỗi ngày. {reward?.policyVersion === 2
        ? 'Ảnh đầu ngày tự nhận 10 Xu cơ bản; cả hai đăng trong 30 phút đầu được thêm 10 Xu mỗi người. Nhiệm vụ chỉ nhận 5 EXP, không cộng thêm Xu.'
        : reward?.policyVersion === 1 ? 'Cả hai chụp trong 30 phút đầu để nhận tổng 40 Xu (20 Xu mỗi người) qua nhiệm vụ theo chính sách cũ.'
          : 'Chụp trong ngày để xem ảnh của nhau và giữ chuỗi. Phần thưởng được xác nhận sau khi ảnh đã lưu.'}</p>
      <p className="text-sm text-muted" role="status">{rewardOpen
        ? 'Ảnh được tính đúng giờ khi máy chủ nhận bài đăng trước hạn thưởng. Ảnh xem trước vẫn được giữ sau hạn này.'
        : reward?.policyVersion === 2 ? 'Đã hết hạn thưởng đủ đôi đúng giờ; ảnh đầu ngày vẫn nhận 10 Xu cơ bản và giữ chuỗi khi cả hai chụp.'
          : 'Đã qua 30 phút đầu — vẫn chụp được hôm nay để giữ chuỗi. Nếu chưa xác nhận được bài đăng, hãy kiểm tra lại ngày gốc.'}</p>
      {status && <p className="composer__status" role="status">{status}</p>}
      {error && <p className="form-feedback" role="alert">{error}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" disabled={busy || needsCheck || now >= Date.parse(closesAt)} onClick={() => active() && onRetake()}>Chụp lại</button>
        <button type="submit" className="btn btn-primary" disabled={busy || (!needsCheck && now >= Date.parse(closesAt))}>{busy && <span className="spinner" aria-hidden="true" />}{needsCheck ? 'Kiểm tra lại' : 'Đăng'}</button>
      </div>
    </form>
  </BottomSheet>;
}
export function MomentTimer({ rewardEndsAt, closesAt, reward }: { rewardEndsAt: string; closesAt: string; reward?: MomentRewardSummary }) {
  const now = useMomentNow(closesAt, rewardEndsAt);
  const left = Date.parse(rewardEndsAt) - now;
  if (now >= Date.parse(closesAt)) return <p className="text-sm text-muted">Ngày chụp đã kết thúc</p>;
  return left > 0 ? <p className="mo-timer" role="timer" aria-live="off">Còn <strong className="num">{mmss(left)}</strong> {reward?.policyVersion === 2
    ? 'để cả hai chụp nhận thêm 10 Xu mỗi người'
    : reward?.policyVersion === 1 ? 'để cả hai chụp nhận tổng 40 Xu · 20 Xu mỗi người' : 'để cả hai chụp đúng giờ'}</p>
    : <p className="text-sm text-muted" role="status">{reward?.policyVersion === 2
      ? 'Đã hết hạn thưởng đủ đôi đúng giờ — ảnh đầu ngày vẫn nhận 10 Xu cơ bản.'
      : reward?.policyVersion === 1 ? 'Đã hết thời gian nhận thưởng — vẫn chụp được hôm nay để giữ chuỗi.'
        : 'Đã qua 30 phút đầu — vẫn chụp được hôm nay để giữ chuỗi.'}</p>;
}
function photoMeta(p: MomentPhoto, session: MomentSession): string {
  const late = session.scheduleVersion === 3
    ? (isMomentPhotoOnTime(session, p.postedAt) ? null : lateText(p.lateMin) ?? 'Sau hạn thưởng')
    : lateText(p.lateMin);
  return late ? `${formatTime(p.postedAt)} · ${late}` : `${formatTime(p.postedAt)} · Đúng giờ`;
}
/** Posting together preserves the streak; only two on-time posts unlock the quest reward. */
export function MomentRewardStatus({ session, reward }: { session: MomentSession; reward?: MomentRewardSummary }) {
  const now = useMomentNow(session.closesAt, session.rewardEndsAt);
  const saved = useSavedMoment(session);
  if (session.scheduleVersion !== 3) return null;
  if (saved && !session.mine) return <p className="text-sm text-muted" role="status">Ảnh đã lưu. Đang cập nhật ảnh và xác nhận thưởng; không cần đăng lại.</p>;
  const late = (session.mine && !isMomentPhotoOnTime(session, session.mine.postedAt))
    || (session.partner.postedAt && !isMomentPhotoOnTime(session, session.partner.postedAt));
  if (reward?.policyVersion === 2) return <div className="stack" role="status">
    <p className="text-sm text-muted">10 Xu cơ bản cho ảnh đầu ngày + 10 Xu thưởng khi cả hai đăng đúng giờ = tối đa 20 Xu của bạn. Xu tự cộng; nhiệm vụ chỉ nhận 5 EXP.</p>
    <p className="text-sm text-muted">{reward.status === 'pending'
      ? `Ảnh đã lưu. Đang xử lý thưởng; đã nhận ${reward.coinAwarded} Xu.`
      : reward.status === 'awarded' ? `Đã nhận ${reward.coinAwarded} Xu của bạn (${reward.baseCoin} cơ bản + ${reward.bonusCoin} thưởng đủ đôi đúng giờ).`
        : session.mine ? 'Ảnh đã lưu; đang chờ xác nhận thưởng.' : 'Bạn chưa đăng ảnh để nhận 10 Xu cơ bản.'}</p>
    <p className="text-sm text-muted">{session.state === 'both' && !late
      ? 'Cả hai đã đăng đúng giờ; thưởng đủ đôi được xác nhận theo trạng thái xử lý bên trên.'
      : late || now >= Date.parse(session.rewardEndsAt) ? 'Không đủ hai ảnh đúng giờ: không có thêm 10 Xu thưởng đủ đôi. Ảnh đầu ngày vẫn có 10 Xu cơ bản.'
        : 'Cần cả hai đăng trước hạn để mỗi người nhận thêm 10 Xu thưởng đủ đôi.'}</p>
  </div>;
  if (reward?.policyVersion !== 1) return session.mine
    ? <p className="text-sm text-muted" role="status">Ảnh đã lưu. Phần thưởng đang chờ xác nhận.</p> : null;
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
  const saved = useSavedMoment(day);
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
    {tile('Bạn', day.mine, saved ? 'Ảnh đã lưu · đang cập nhật' : day.closed ? (daily ? 'Bạn bỏ lỡ ngày này' : 'Bạn bỏ lỡ lượt này') : 'Bạn chưa chụp')}
    {tile(partnerName, day.partner.photo, day.partner.posted
      ? `${partnerName} đã chụp · ${saved ? 'Đang cập nhật ảnh' : day.closed ? `Ảnh được giữ kín vì bạn bỏ lỡ ${daily ? 'ngày' : 'lượt'} này` : daily ? 'Chụp hôm nay để xem' : 'Chụp cùng lượt để xem'}`
      : `${partnerName} ${day.closed ? `bỏ lỡ ${daily ? 'ngày' : 'lượt'} này` : 'chưa chụp'}`)}
  </div>;
}
