import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatTime } from '../../lib/format';
import type { MomentDay, MomentPhoto } from '../../lib/types';
import { useNow } from '../events/Countdown';
import { MAX_MOMENT_CAPTION, lateText, mmss, momentsApi, refreshMoments, uploadMomentPhoto } from './api';

/**
 * "Chụp ngay": opens the camera (`capture`; on the web a photo from the gallery can still be picked, which the plan accepts),
 * then a sheet with the preview and one line before posting.
 */
export function CaptureButton({ className, label = 'Chụp ngay', onPosted }: { className: string; label?: string; onPosted?: (day: MomentDay) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (f && f.type.startsWith('image/')) setFile(f);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => fileRef.current?.click()}>
        <Icon name="camera" size={20} /> {label}
      </button>
      <input ref={fileRef} type="file" accept="image/*" capture hidden aria-label="Chụp ảnh Khoảnh khắc" onChange={onPick} />
      {file && (
        <PostMomentSheet
          key={`${file.name}-${file.lastModified}-${file.size}`}
          file={file}
          onRetake={() => fileRef.current?.click()}
          onClose={() => setFile(null)}
          onPosted={(day) => {
            setFile(null);
            onPosted?.(day);
          }}
        />
      )}
    </>
  );
}

function PostMomentSheet({ file, onRetake, onClose, onPosted }: { file: File; onRetake: () => void; onClose: () => void; onPosted: (day: MomentDay) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const uploaded = useRef<{ key: string; width: number; height: number } | null>(null);

  // Made inside the effect so React's dev double-run (StrictMode) never revokes the URL the image is still using.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!uploaded.current) {
        setStatus('Đang tải ảnh…');
        uploaded.current = await uploadMomentPhoto(file);
      }
      setStatus('Đang đăng…');
      const day = await momentsApi.post({ ...uploaded.current, caption: caption.trim() });
      toast.success('Đã đăng Khoảnh khắc 📸');
      await refreshMoments(qc);
      onPosted(day);
    } catch (err) {
      const message = err instanceof ApiRequestError || err instanceof Error ? err.message : 'Chưa đăng được, thử lại nhé.';
      setError(message);
      if (err instanceof ApiRequestError && (err.code === 'MOMENT_ALREADY_POSTED' || err.code === 'MOMENT_NOT_YET')) {
        toast.error(message);
        await refreshMoments(qc);
        onClose();
      }
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <BottomSheet open title="Khoảnh khắc của bạn" onClose={() => !busy && onClose()}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="mo-preview">{preview && <img src={preview} alt="Ảnh bạn vừa chụp" />}</div>
        <label className="field">
          <span className="field__label">Một dòng (tuỳ chọn)</span>
          <input
            className="input"
            value={caption}
            maxLength={MAX_MOMENT_CAPTION}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Bạn đang làm gì?"
            disabled={busy}
          />
          <span className="char-count">
            {caption.length}/{MAX_MOMENT_CAPTION}
          </span>
        </label>
        <p className="text-sm text-muted">Đăng xong bạn sẽ thấy ngay ảnh của người ấy (nếu người ấy đã chụp). Mỗi ngày một tấm, không sửa được.</p>
        {status && (
          <p className="composer__status" role="status">
            {status}
          </p>
        )}
        {error && <p className="form-feedback" role="alert">{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRetake}>
            Chụp lại
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Đăng
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

/** "Còn 07:42 để đúng giờ", then "Đã quá 10 phút · vẫn chụp được tới 23:59". */
export function MomentTimer({ windowEndsAt }: { windowEndsAt: string | null }) {
  const end = windowEndsAt ? new Date(windowEndsAt).getTime() : 0;
  const now = useNow(1000, end > Date.now());
  const left = end - now;
  if (left > 0) {
    return (
      <p className="mo-timer" role="timer" aria-live="off">
        Còn <strong className="num">{mmss(left)}</strong> để đúng giờ
      </p>
    );
  }
  return <p className="mo-timer mo-timer--late">Đã quá 10 phút · vẫn chụp được tới 23:59</p>;
}

function photoMeta(p: MomentPhoto): string {
  const late = lateText(p.lateMin);
  return late ? `${formatTime(p.postedAt)} · ${late}` : `${formatTime(p.postedAt)} · Đúng giờ`;
}

/**
 * The day's two photos side by side: mine, then the partner's. The partner's photo is only there once I have posted
 * (the server leaves it out before); until then a locked tile says whether they have taken theirs.
 */
export function MomentPair({
  day,
  partnerName,
  onOpenPhoto,
  size = 'lg',
}: {
  day: MomentDay;
  partnerName: string;
  onOpenPhoto?: (urls: string[], index: number) => void;
  size?: 'lg' | 'md';
}) {
  const urls = [day.mine?.url, day.partner.photo?.url].filter((u): u is string => Boolean(u));
  const open = (url: string) => onOpenPhoto?.(urls, urls.indexOf(url));

  const tile = (who: string, photo: MomentPhoto | null, empty: { icon: string; text: string; hint?: string; locked?: boolean }) => (
    <figure className="mo-tile">
      {photo ? (
        <button type="button" className="mo-tile__photo" onClick={() => open(photo.url)} aria-label={`Xem lớn ảnh của ${who}`}>
          <img src={photo.url} alt={`Ảnh của ${who}`} loading="lazy" />
        </button>
      ) : (
        <div className={`mo-tile__empty${empty.locked ? ' mo-tile__empty--locked' : ''}`}>
          <span className="mo-tile__icon" aria-hidden="true">
            {empty.icon}
          </span>
          <span className="mo-tile__text">{empty.text}</span>
          {empty.hint && <span className="mo-tile__hint">{empty.hint}</span>}
        </div>
      )}
      <figcaption className="mo-tile__cap">
        <span className="mo-tile__who">{who}</span>
        {photo && <span className={`mo-tile__meta${photo.lateMin > 0 ? ' mo-tile__meta--late' : ''}`}>{photoMeta(photo)}</span>}
        {photo?.caption && <span className="mo-tile__caption">“{photo.caption}”</span>}
      </figcaption>
    </figure>
  );

  const mineEmpty = day.closed ? { icon: '🌙', text: 'Bạn bỏ lỡ' } : day.state === 'waiting' ? { icon: '⏳', text: 'Chưa tới giờ' } : { icon: '📸', text: 'Bạn chưa chụp' };
  const partnerEmpty = day.partner.posted
    ? { icon: '🔒', text: `${partnerName} đã chụp`, hint: day.closed ? 'Bạn không chụp hôm đó' : 'Chụp để xem', locked: true }
    : day.closed
      ? { icon: '🌙', text: `${partnerName} bỏ lỡ` }
      : { icon: '⏳', text: `${partnerName} chưa chụp` };

  return (
    <div className={`mo-pair mo-pair--${size}`}>
      {tile('Bạn', day.mine, mineEmpty)}
      {tile(partnerName, day.partner.photo, partnerEmpty)}
    </div>
  );
}
