import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useModal } from '../../hooks/useModal';
import { useComposerFeedback } from '../../hooks/useComposerFeedback';
import '../stories/form-interactions.css';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { formatDay, localDateOf, shortName } from '../../lib/format';
import type { Mood, Story } from '../../lib/types';
import { storiesApi } from './api';
import { PostMediaEditor } from './PostMediaEditor';
import { POST_MEDIA_ACCEPT, type ExistingMedia } from './postMedia';
import { usePostMedia } from './usePostMedia';
import { uploadPostMedia, type PostMediaUploadCache } from './uploadPostMedia';
import { prependStoryToFeed, replaceStoryInCache } from './cache';
import { DateSheet, LeaveSheet, MoodSheet } from './ComposerPickers';
import { moodOf } from './constants';
import { clearDraft, loadDraft, saveDraft } from './draft';

function existingMedia(story: Story | null): ExistingMedia[] {
  return [
    ...(story?.photos ?? []).map((p) => ({ ...p, id: p.key, kind: 'existing' as const, mediaType: 'image' as const })),
    ...(story?.videos ?? []).map((v) => ({ ...v, id: v.key, kind: 'existing' as const, mediaType: 'video' as const })),
  ];
}

interface Props {
  open: boolean;
  /** null = new post. */
  editing: Story | null;
  /** Media picked from the feed before the composer opened. */
  initialFiles?: File[];
  onClose: () => void;
}

/** Full-screen "Tạo bài viết" / "Chỉnh sửa bài viết". Mounted only while open, so each open starts fresh. */
export function StoryComposer({ open, editing, initialFiles, onClose }: Props) {
  if (!open) return null;
  return createPortal(<ComposerDialog editing={editing} initialFiles={initialFiles ?? []} onClose={onClose} />, document.body);
}

function ComposerDialog({ editing, initialFiles, onClose }: { editing: Story | null; initialFiles: File[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const userId = me?.user.id ?? '';
  const authorName = me?.user.displayName ?? '';
  const tz = me?.couple?.timezone ?? 'Asia/Ho_Chi_Minh';
  const today = localDateOf(new Date(), tz);
  const baseDay = editing ? localDateOf(editing.createdAt, tz) : today;

  const [draft] = useState(() => (editing ? null : loadDraft(userId)));
  const [body, setBody] = useState(editing?.body ?? draft?.body ?? '');
  const [mood, setMood] = useState<Mood | null>(editing?.mood ?? draft?.mood ?? null);
  // New posts: null = "today at posting time". Edits always keep an explicit day.
  const [happenedOn, setHappenedOn] = useState<string | null>(editing?.happenedOn ?? draft?.happenedOn ?? null);
  const { media, addFiles, remove, pending, errors: mediaErrors } = usePostMedia(existingMedia(editing), initialFiles);
  const [moodOpen, setMoodOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { error, setError, errorRef, submitting, errorId, hintId } = useComposerFeedback();

  const uploaded = useRef<PostMediaUploadCache>(new Map());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const finished = useRef(false); // posted or discarded: stop autosaving the draft
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Grow the textarea with its content.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body, media.length]);

  // Autosave text, mood and date for new posts (survives the phone killing the tab).
  useEffect(() => {
    if (editing || !userId) return;
    const t = window.setTimeout(() => {
      if (!finished.current) saveDraft(userId, { body, mood, happenedOn });
    }, 400);
    return () => window.clearTimeout(t);
  }, [editing, userId, body, mood, happenedOn]);

  const original = useMemo(
    () => (editing ? JSON.stringify([editing.body, editing.mood ?? null, editing.happenedOn, existingMedia(editing).map((p) => p.key)]) : ''),
    [editing],
  );
  const current = JSON.stringify([body.trim(), mood, happenedOn, media.map((p) => (p.kind === 'existing' ? p.key : p.id))]);
  const hasContent = body.trim().length > 0 || media.length > 0;
  const changed = editing ? current !== original : hasContent || mood !== null || happenedOn !== null;
  const canSubmit = !busy && !pending && !mediaErrors && hasContent && (!editing || changed);

  const m = moodOf(mood);
  const effectiveDay = happenedOn ?? today;
  const showDay = effectiveDay !== baseDay;
  const big = media.length === 0 && body.length < 85 && !body.includes('\n');

  function finish() {
    finished.current = true;
    onClose();
  }

  function confirmClose() {
    if (busy || submitting.current) return;
    if (changed) setLeaveOpen(true);
    else finish();
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (submitting.current) return;
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    addFiles(files);
  }

  function removeMedia(id: string) {
    uploaded.current.delete(id);
    remove(id);
  }

  async function submit() {
    if (!canSubmit || submitting.current) return;
    const generation = tokenStore.generation();
    const assertActive = () => {
      assertCurrentSession(generation);
      if (!mounted.current) throw new DOMException('Đã đóng bài viết.', 'AbortError');
    };
    submitting.current = true;
    setError(null);
    setBusy(true);
    try {
      const attachments = await uploadPostMedia(media, uploaded.current, storiesApi, setStatus, assertActive);
      assertActive();
      setStatus(editing ? 'Đang lưu…' : 'Đang đăng…');
      const input = { body: body.trim(), mood, happenedOn, ...attachments };
      const story = editing ? await storiesApi.update(editing.id, input) : await storiesApi.create(input);
      assertActive();
      if (editing) {
        replaceStoryInCache(qc, story);
      } else {
        clearDraft(userId);
        prependStoryToFeed(qc, story);
      }
      toast.success(editing ? 'Đã lưu thay đổi' : 'Đã đăng bài viết 💞');
      finish();
    } catch (err) {
      if (!mounted.current || !tokenStore.isCurrent(generation)) return;
      // ApiRequestError extends Error, so server messages ("Có ảnh chưa tải lên xong…") show as-is.
      setError(err instanceof Error ? err.message : 'Không đăng được, thử lại nhé.');
      submitting.current = false;
      setBusy(false);
      setStatus(null);
    }
  }

  const { dialogRef, requestClose } = useModal({ open: true, onClose: confirmClose, busy, initialFocusRef: textRef });

  return (
    <div ref={dialogRef} tabIndex={-1} className="composer composer--form" role="dialog" aria-modal="true" aria-labelledby="composer-title" aria-busy={busy}>
      <header className="composer__bar">
        <button type="button" className="icon-btn" aria-label="Đóng" disabled={busy} onClick={requestClose}>
          <Icon name="x" />
        </button>
        <h2 id="composer-title" className="composer__title">
          {editing ? 'Chỉnh sửa bài viết' : 'Tạo bài viết'}
        </h2>
      </header>

      <div className="composer__scroll">
        <div className="composer__author">
          <Avatar name={authorName} src={me?.user.avatarUrl} size={44} />
          <div style={{ minWidth: 0 }}>
            <p className="post__name">
              <strong>{authorName}</strong>
              {m && (
                <span className="post__mood">
                  {' '}
                  đang cảm thấy {m.emoji} <strong>{m.label}</strong>
                </span>
              )}
            </p>
            <div className="composer__chips">
              <span className="chip">
                <Icon name="lock" size={12} /> Chỉ hai bạn
              </span>
              {showDay && (
                <button type="button" className="chip chip--brand" disabled={busy} onClick={() => setDateOpen(true)}>
                  <Icon name="calendar" size={12} /> Kỷ niệm {formatDay(effectiveDay)}
                </button>
              )}
            </div>
          </div>
        </div>

        <textarea
          ref={textRef}
          className={`composer__text${big ? ' composer__text--big' : ''}`}
          readOnly={busy}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={20_000}
          rows={3}
          aria-label="Nội dung bài viết"
          placeholder={media.length ? 'Hãy nói gì đó về ảnh hoặc video này…' : `${shortName(authorName)} ơi, bạn đang nghĩ gì?`}
        />

        <PostMediaEditor media={media} busy={busy} onRemove={removeMedia} onAdd={() => fileRef.current?.click()} />
      </div>

      <footer className="composer__footer">
        {status && (
          <p className="composer__status" role="status">
            {status}
          </p>
        )}
        {error && <p ref={errorRef} id={errorId} className="form-feedback" role="alert" tabIndex={-1}>{error}</p>}
        {pending && <p className="composer__status" role="status">Đang xử lý ảnh/video…</p>}
        <p id={hintId} className="composer__hint">Chỉ hai bạn xem được bài viết. Tối đa 10 tệp, gồm 1 video MP4/WebM/MOV ≤ 50 MiB.</p>
        <div className="composer__tools">
          <span className="composer__tools-label">Thêm vào bài viết</span>
          <button
            type="button"
            className="tool-btn tool-btn--photo"
            aria-label="Thêm ảnh hoặc video"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="image" />
          </button>
          <button type="button" className={`tool-btn tool-btn--mood${mood ? ' is-on' : ''}`} aria-label="Cảm xúc" disabled={busy} onClick={() => setMoodOpen(true)}>
            <Icon name="smile" />
          </button>
          <button type="button" className={`tool-btn tool-btn--date${showDay ? ' is-on' : ''}`} aria-label="Ngày kỷ niệm" disabled={busy} onClick={() => setDateOpen(true)}>
            <Icon name="calendar" />
          </button>
        </div>

        <div className="composer__action">
          <button type="button" className="btn btn-primary composer__submit" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {editing ? 'Lưu' : 'Đăng'}
          </button>
        </div>
      </footer>

      <input ref={fileRef} disabled={busy} type="file" accept={POST_MEDIA_ACCEPT} multiple hidden onChange={onPick} />

      <MoodSheet open={moodOpen} value={mood} onClose={() => setMoodOpen(false)} onPick={setMood} />
      <DateSheet
        open={dateOpen}
        value={effectiveDay}
        max={today}
        resetDay={baseDay}
        resetLabel={editing ? 'Ngày đăng bài' : 'Hôm nay'}
        onClose={() => setDateOpen(false)}
        onPick={(d) => setHappenedOn(!editing && d === today ? null : d)}
      />
      <LeaveSheet
        open={leaveOpen}
        editing={Boolean(editing)}
        hasPhotos={media.some((p) => p.kind === 'new')}
        onKeep={() => setLeaveOpen(false)}
        onSaveDraft={() => {
          saveDraft(userId, { body, mood, happenedOn });
          finish();
        }}
        onDiscard={() => {
          if (!editing) clearDraft(userId);
          finish();
        }}
      />
    </div>
  );
}
