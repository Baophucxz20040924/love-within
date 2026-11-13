import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useModal } from '../../hooks/useModal';
import { useComposerFeedback } from '../../hooks/useComposerFeedback';
import '../stories/form-interactions.css';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { formatDay } from '../../lib/format';
import type { LetterView } from '../../lib/types';
import { useAvatarOf } from '../auth/useAvatarOf';
import { daysLeftText, eventDayText } from '../events/constants';
import { useCouplePeople } from '../questions/useCouplePeople';
import { MAX_LETTER_BODY, MAX_LETTER_PHOTOS, MAX_LETTER_TITLE, letterKey, lettersApi, refreshLetters, uploadLetterPhoto } from './api';
import { OpenDateSheet } from './OpenDateSheet';
import { daysBetween, inOpenRange } from './openDates';

type LocalPhoto =
  | { id: string; kind: 'existing'; key: string; url: string; width: number; height: number }
  | { id: string; kind: 'new'; file: File; url: string };

type Uploaded = { key: string; width: number; height: number };

let seq = 0;
const nextId = () => `lp${++seq}`;

interface Props {
  open: boolean;
  /** null = new letter. Must carry its content (the author's own letter). */
  editing: LetterView | null;
  /** New letter: open date chosen beforehand (e.g. "Viết thư mở vào ngày này" on an event). */
  initialOpenOn?: string | null;
  /** New letter: title to start with (reply). */
  initialTitle?: string;
  onClose: () => void;
  onSaved?: (letter: LetterView) => void;
}

/** Full-screen "Viết thư" / "Sửa thư" (CP2), like the story composer. Mounted only while open, so each open starts fresh. */
export function LetterComposer({ open, ...rest }: Props) {
  if (!open) return null;
  return createPortal(<ComposerDialog {...rest} />, document.body);
}

function ComposerDialog({ editing, initialOpenOn, initialTitle, onClose, onSaved }: Omit<Props, 'open'>) {
  const qc = useQueryClient();
  const toast = useToast();
  const avatarOf = useAvatarOf();
  const { partnerId, partnerName, partnerFullName, today } = useCouplePeople();
  const content = editing?.content ?? null;

  const [title, setTitle] = useState(content?.title ?? initialTitle ?? '');
  const [body, setBody] = useState(content?.body ?? '');
  const [openOn, setOpenOn] = useState<string | null>(
    editing ? editing.openOn : initialOpenOn && inOpenRange(initialOpenOn, today) ? initialOpenOn : null,
  );
  const [photos, setPhotos] = useState<LocalPhoto[]>(() =>
    (content?.photos ?? []).map((p) => ({ id: nextId(), kind: 'existing' as const, ...p })),
  );
  const [dateOpen, setDateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { error, setError, errorRef, submitting, errorId, hintId } = useComposerFeedback();

  const uploaded = useRef(new Map<string, Uploaded>()); // reused if sending is retried after an error
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  useEffect(() => {
    return () => {
      for (const p of photosRef.current) if (p.kind === 'new') URL.revokeObjectURL(p.url);
    };
  }, []);

  // Grow the textarea with its content.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body, photos.length]);

  const original = useMemo(
    () => (editing && content ? JSON.stringify([content.title, content.body, editing.openOn, content.photos.map((p) => p.key)]) : ''),
    [editing, content],
  );
  const current = JSON.stringify([title.trim(), body.trim(), openOn, photos.map((p) => (p.kind === 'existing' ? p.key : p.id))]);
  const changed = editing ? current !== original : title.trim().length > 0 || body.trim().length > 0 || photos.length > 0 || openOn !== (initialOpenOn && inOpenRange(initialOpenOn, today) ? initialOpenOn : null);
  // Editing keeps its current date even when that day has come (the letter is not opened yet).
  const dateValid = openOn !== null && (openOn === editing?.openOn || inOpenRange(openOn, today));
  const canPress = !busy && body.trim().length > 0 && (!editing || changed);

  function confirmClose() {
    if (busy || submitting.current) return;
    if (changed) setLeaveOpen(true);
    else onClose();
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (submitting.current) return;
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    const room = MAX_LETTER_PHOTOS - photos.length;
    if (files.length > room) toast.info(`Mỗi lá thư tối đa ${MAX_LETTER_PHOTOS} ảnh`);
    const added = files.slice(0, Math.max(0, room)).map((file) => ({ id: nextId(), kind: 'new' as const, file, url: URL.createObjectURL(file) }));
    if (added.length) setPhotos((ps) => [...ps, ...added]);
  }

  function removePhoto(id: string) {
    const p = photos.find((x) => x.id === id);
    if (p?.kind === 'new') URL.revokeObjectURL(p.url);
    uploaded.current.delete(id);
    setPhotos((ps) => ps.filter((x) => x.id !== id));
  }

  async function submit() {
    if (!canPress || submitting.current) return;
    if (!dateValid || !openOn) {
      setError('Hãy chọn ngày mở thư trước khi gửi.');
      setDateOpen(true);
      return;
    }
    submitting.current = true;
    setError(null);
    setBusy(true);
    try {
      const total = photos.filter((p) => p.kind === 'new').length;
      const out: Uploaded[] = [];
      let n = 0;
      for (const p of photos) {
        if (p.kind === 'existing') {
          out.push({ key: p.key, width: p.width, height: p.height });
          continue;
        }
        n += 1;
        let up = uploaded.current.get(p.id);
        if (!up) {
          setStatus(`Đang tải ảnh ${n}/${total}…`);
          up = await uploadLetterPhoto(p.file);
          uploaded.current.set(p.id, up);
        }
        out.push(up);
      }
      setStatus(editing ? 'Đang lưu…' : 'Đang gửi…');
      const input = { title: title.trim(), body: body.trim(), openOn, photos: out };
      const letter = editing ? await lettersApi.update(editing.id, input) : await lettersApi.create(input);
      qc.setQueryData(letterKey(letter.id), letter);
      await refreshLetters(qc);
      toast.success(editing ? 'Đã lưu thay đổi' : `Đã gửi thư 💌 ${partnerName} mở được từ ${formatDay(letter.openOn)}.`);
      onSaved?.(letter);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không gửi được, thử lại nhé.');
      submitting.current = false;
      setBusy(false);
      setStatus(null);
    }
  }

  const { dialogRef, requestClose } = useModal({ open: true, onClose: confirmClose, busy, initialFocusRef: textRef });

  return (
    <div ref={dialogRef} tabIndex={-1} className="composer composer--form" role="dialog" aria-modal="true" aria-labelledby="letter-composer-title" aria-busy={busy}>
      <header className="composer__bar">
        <button type="button" className="icon-btn" aria-label="Đóng" disabled={busy} onClick={requestClose}>
          <Icon name="x" />
        </button>
        <h2 id="letter-composer-title" className="composer__title">
          {editing ? 'Sửa thư' : 'Viết thư'}
        </h2>
      </header>

      <div className="composer__scroll">
        <div className="composer__author">
          <Avatar name={partnerFullName} src={avatarOf(partnerId)} size={44} />
          <div style={{ minWidth: 0 }}>
            <p className="post__name">
              Gửi <strong>{partnerFullName}</strong>
            </p>
            <div className="composer__chips">
              <span className="chip">
                <Icon name="lock" size={12} /> Niêm phong tới ngày mở
              </span>
            </div>
          </div>
        </div>

        <button type="button" className={`letter-when${dateValid ? ' is-set' : ''}`} disabled={busy} aria-invalid={Boolean(error && !dateValid)} aria-describedby={error && !dateValid ? errorId : undefined} onClick={() => setDateOpen(true)}>
          <span className="icon-tile" aria-hidden="true">
            <Icon name="calendar" size={20} />
          </span>
          <span className="letter-when__body">
            <span className="letter-when__label">Ngày mở</span>
            <span className="letter-when__value">
              {dateValid && openOn ? `${eventDayText(openOn)} · ${daysLeftText(daysBetween(today, openOn))}` : 'Chọn ngày mở thư'}
            </span>
          </span>
          <Icon name="chevronRight" className="text-muted" />
        </button>

        <input
          className="letter-title-input"
          readOnly={busy}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={MAX_LETTER_TITLE}
          aria-label="Tiêu đề thư"
          placeholder="Tiêu đề (tuỳ chọn)"
        />
        <textarea
          ref={textRef}
          className="composer__text letter-text"
          readOnly={busy}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={MAX_LETTER_BODY}
          rows={6}
          aria-label="Nội dung thư"
          placeholder={`${partnerName} thân mến,…`}
        />
        {body.length > MAX_LETTER_BODY - 2000 && (
          <p className="char-count letter-count">
            {body.length.toLocaleString('vi-VN')}/{MAX_LETTER_BODY.toLocaleString('vi-VN')}
          </p>
        )}

        {photos.length > 0 && (
          <div className="composer__photos">
            {photos.map((p) => (
              <div key={p.id} className="composer__photo">
                <img src={p.url} alt="" />
                <button type="button" className="composer__photo-remove" aria-label="Bỏ ảnh này" disabled={busy} onClick={() => removePhoto(p.id)}>
                  <span>
                    <Icon name="x" size={16} />
                  </span>
                </button>
              </div>
            ))}
            {photos.length < MAX_LETTER_PHOTOS && (
              <button type="button" className="composer__add" aria-label="Thêm ảnh" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Icon name="plus" size={26} />
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="composer__footer">
        {status && (
          <p className="composer__status" role="status">
            {status}
          </p>
        )}
        {error && <p ref={errorRef} id={errorId} className="form-feedback" role="alert" tabIndex={-1}>{error}</p>}
        <p id={hintId} className="composer__hint">Nội dung và ảnh sẽ được niêm phong đến ngày mở thư.</p>
        <div className="composer__tools">
          <span className="composer__tools-label">Thêm vào thư</span>
          <button
            type="button"
            className="tool-btn tool-btn--photo"
            aria-label={`Thêm ảnh (tối đa ${MAX_LETTER_PHOTOS})`}
            disabled={busy || photos.length >= MAX_LETTER_PHOTOS}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="image" />
          </button>
          <button
            type="button"
            className={`tool-btn tool-btn--date${dateValid ? ' is-on' : ''}`}
            aria-label="Ngày mở thư"
            disabled={busy}
            onClick={() => setDateOpen(true)}
          >
            <Icon name="calendar" />
          </button>
        </div>

        <div className="composer__action">
          <button type="button" className="btn btn-primary composer__submit" disabled={!canPress} onClick={() => void submit()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {editing ? 'Lưu' : 'Gửi'}
          </button>
        </div>
      </footer>

      <input ref={fileRef} disabled={busy} type="file" accept="image/*" multiple hidden onChange={onPick} />

      <OpenDateSheet open={dateOpen} value={openOn} keepDate={editing?.openOn ?? null} onClose={() => setDateOpen(false)} onPick={(day) => { setOpenOn(day); setError(null); }} />
      <BottomSheet open={leaveOpen} onClose={() => setLeaveOpen(false)} title={editing ? 'Bỏ thay đổi?' : 'Bỏ lá thư này?'}>
        <div className="stack">
          <p className="text-muted">{editing ? 'Những thay đổi chưa lưu sẽ mất.' : 'Những gì bạn đã viết sẽ mất.'}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setLeaveOpen(false)}>
              Viết tiếp
            </button>
            <button type="button" className="btn btn-danger" onClick={onClose}>
              {editing ? 'Bỏ thay đổi' : 'Bỏ thư'}
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
