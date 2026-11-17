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
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { formatDateTime, shortName } from '../../lib/format';
import type { FriendPollInput, FriendStory, PollDurationDays } from '../../lib/types';
import { friendStoriesApi } from './api';
import { PostMediaEditor } from '../stories/PostMediaEditor';
import { POST_MEDIA_ACCEPT, type ExistingMedia } from '../stories/postMedia';
import { usePostMedia } from '../stories/usePostMedia';
import { uploadPostMedia, type PostMediaUploadCache } from '../stories/uploadPostMedia';
import { prependFriendStoryToFeed, replaceFriendStoryInCache } from './cache';
import { MentionField } from './MentionField';
import { fromPayload, toPayload, type DraftMention } from './mentions';

const mentionSearch = { id: 'draft-post', fn: friendStoriesApi.draftMentionable };

/** Poll (BB6): 2–4 options of ≤ 80 characters. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_OPTION_LEN = 80;
type Duration = PollDurationDays | 'keep';
const DURATIONS: { value: PollDurationDays; label: string }[] = [
  { value: 0, label: 'Không' },
  { value: 1, label: '1 ngày' },
  { value: 3, label: '3 ngày' },
  { value: 7, label: '7 ngày' },
];
const sameText = (a: string, b: string) => a.toLocaleLowerCase('vi') === b.toLocaleLowerCase('vi');

function existingMedia(story: FriendStory | null): ExistingMedia[] {
  return [
    ...(story?.photos ?? []).map((p) => ({ ...p, id: p.key, kind: 'existing' as const, mediaType: 'image' as const })),
    ...(story?.videos ?? []).map((v) => ({ ...v, id: v.key, kind: 'existing' as const, mediaType: 'video' as const })),
  ];
}

interface Props {
  open: boolean;
  /** null = new post. */
  editing: FriendStory | null;
  /** Media picked from the feed before the composer opened. */
  initialFiles?: File[];
  /** Text to start a new post with (BB5 "Đăng ảnh buổi này": the event title). */
  initialBody?: string;
  onClose: () => void;
}

/** Full-screen "Tạo bài viết" / "Chỉnh sửa bài viết" for the friends feed. Mounted only while open. */
export function FriendComposer({ open, editing, initialFiles, initialBody, onClose }: Props) {
  if (!open) return null;
  return createPortal(<ComposerDialog editing={editing} initialFiles={initialFiles ?? []} initialBody={initialBody ?? ''} onClose={onClose} />, document.body);
}

function ComposerDialog({
  editing,
  initialFiles,
  initialBody,
  onClose,
}: {
  editing: FriendStory | null;
  initialFiles: File[];
  initialBody: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const authorName = me?.user.displayName ?? '';

  const [body, setBody] = useState(editing?.body ?? initialBody);
  const [mentions, setMentions] = useState<DraftMention[]>(() => editing ? fromPayload(editing.body, editing.mentions ?? []) : []);
  const { media, addFiles, remove, pending, errors: mediaErrors } = usePostMedia(existingMedia(editing), initialFiles);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { error, setError, errorRef, submitting, errorId, hintId } = useComposerFeedback();

  // Poll (BB6). Editing a poll that has votes: only the question (the body) may change.
  const existingPoll = editing?.poll ?? null;
  const locked = (existingPoll?.totalVoters ?? 0) > 0;
  const [pollOn, setPollOn] = useState(existingPoll !== null);
  const [options, setOptions] = useState<string[]>(() => (existingPoll ? existingPoll.options.map((o) => o.text) : ['', '']));
  const [multi, setMulti] = useState(existingPoll?.multi ?? false);
  const [duration, setDuration] = useState<Duration>(existingPoll ? 'keep' : 0);
  const optionRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusOption = useRef<number | null>(null);

  const uploaded = useRef<PostMediaUploadCache>(new Map());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea with its content.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body, media.length]);

  // Focus the option the user just added (or the first one when the poll opens).
  useEffect(() => {
    if (focusOption.current === null) return;
    optionRefs.current[focusOption.current]?.focus();
    focusOption.current = null;
  });

  const filled = options.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const duplicate = filled.some((t, i) => filled.some((u, j) => j < i && sameText(t, u)));
  const pollProblem = !pollOn
    ? null
    : !body.trim()
      ? 'Viết câu hỏi cho bình chọn ở ô phía trên.'
      : locked
        ? null
        : filled.length < MIN_OPTIONS
          ? `Cần ít nhất ${MIN_OPTIONS} lựa chọn.`
          : duplicate
            ? 'Các lựa chọn phải khác nhau.'
            : null;
  const pollSig = pollOn ? [locked ? 'locked' : filled, multi, duration] : null;

  const original = useMemo(
    () =>
      editing
        ? JSON.stringify([
            editing.body,
            toPayload(editing.body, fromPayload(editing.body, editing.mentions ?? [])).mentions,
            existingMedia(editing).map((p) => p.key),
            editing.poll ? [locked ? 'locked' : editing.poll.options.map((o) => o.text), editing.poll.multi, 'keep'] : null,
          ])
        : '',
    [editing, locked],
  );
  const payload = toPayload(body, mentions);
  const current = JSON.stringify([payload.body, payload.mentions, media.map((p) => (p.kind === 'existing' ? p.key : p.id)), pollSig]);
  const hasContent = body.trim().length > 0 || media.length > 0;
  const changed = editing ? current !== original : hasContent || pollOn;
  const canSubmit = !busy && !pending && !mediaErrors && hasContent && !pollProblem && (!editing || changed);
  const big = media.length === 0 && body.length < 85 && !body.includes('\n');

  /** Create: a poll or nothing. Edit: left out = keep (always when it has votes), null = remove. */
  function pollInput(): FriendPollInput | null | undefined {
    if (locked) return undefined;
    if (!pollOn) return existingPoll ? null : undefined;
    const input: FriendPollInput = { options: filled, multi };
    if (duration !== 'keep') input.durationDays = duration;
    return input;
  }

  function togglePoll() {
    if (pollOn && locked) {
      toast.info('Đã có người bình chọn nên không gỡ được bình chọn.');
      return;
    }
    if (!pollOn) focusOption.current = body.trim() ? 0 : null;
    if (!pollOn && !body.trim()) textRef.current?.focus();
    setPollOn((on) => !on);
  }

  function setOption(i: number, text: string) {
    setOptions((os) => os.map((t, j) => (j === i ? text : t)));
  }

  function addOption() {
    if (options.length >= MAX_OPTIONS) return;
    focusOption.current = options.length;
    setOptions((os) => [...os, '']);
  }

  function removeOption(i: number) {
    setOptions((os) => (os.length > MIN_OPTIONS ? os.filter((_, j) => j !== i) : os));
  }

  function confirmClose() {
    if (busy || submitting.current) return;
    if (changed) setLeaveOpen(true);
    else onClose();
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
      const attachments = await uploadPostMedia(media, uploaded.current, friendStoriesApi, setStatus, assertActive);
      assertActive();
      setStatus(editing ? 'Đang lưu…' : 'Đang đăng…');
      const input = { ...payload, ...attachments, poll: pollInput() };
      const story = editing ? await friendStoriesApi.update(editing.id, input) : await friendStoriesApi.create(input);
      assertActive();
      if (editing) replaceFriendStoryInCache(qc, story);
      else prependFriendStoryToFeed(qc, story);
      toast.success(editing ? 'Đã lưu thay đổi' : 'Đã đăng bài viết');
      onClose();
    } catch (err) {
      if (!mounted.current || !tokenStore.isCurrent(generation)) return;
      setError(err instanceof Error ? err.message : 'Không đăng được, thử lại nhé.');
      submitting.current = false;
      setBusy(false);
      setStatus(null);
    }
  }

  const { dialogRef, requestClose } = useModal({ open: true, onClose: confirmClose, busy, initialFocusRef: textRef });

  return (
    <div ref={dialogRef} tabIndex={-1} className="composer composer--form" role="dialog" aria-modal="true" aria-labelledby="friend-composer-title" aria-busy={busy}>
      <header className="composer__bar">
        <button type="button" className="icon-btn" aria-label="Đóng" disabled={busy} onClick={requestClose}>
          <Icon name="x" />
        </button>
        <h2 id="friend-composer-title" className="composer__title">
          {editing ? 'Chỉnh sửa bài viết' : 'Tạo bài viết'}
        </h2>
      </header>

      <div className="composer__scroll">
        <div className="composer__author">
          <Avatar name={authorName} src={me?.user.avatarUrl} size={44} />
          <div style={{ minWidth: 0 }}>
            <p className="post__name">
              <strong>{authorName}</strong>
            </p>
            <div className="composer__chips">
              <span className="chip">
                <Icon name="users" size={12} /> Bạn bè
              </span>
            </div>
          </div>
        </div>

        <MentionField
          search={mentionSearch}
          inputRef={textRef}
          variant="composer"
          big={big}
          readOnly={busy}
          invalid={pollOn && !body.trim()}
          describedBy={`${hintId}${error ? ` ${errorId}` : ''}${pollProblem ? ' poll-editor-problem' : ''}`}
          text={body}
          mentions={mentions}
          onChange={(text, spans) => { setBody(text); setMentions(spans); }}
          maxLength={20_000}
          rows={3}
          label={pollOn ? 'Câu hỏi bình chọn' : 'Nội dung bài viết'}
          placeholder={
            pollOn
              ? 'Đặt câu hỏi, ví dụ: Cuối tuần đi đâu?'
              : media.length
                ? 'Hãy nói gì đó về ảnh hoặc video này…'
                : `${shortName(authorName)} ơi, bạn đang nghĩ gì?`
          }
        />

        {pollOn && (
          <section className="poll-editor" aria-labelledby="poll-editor-title">
            <div className="poll-editor__head">
              <h3 id="poll-editor-title" className="poll-editor__title">
                <Icon name="list" size={18} /> Bình chọn
              </h3>
              {!locked && (
                <button type="button" className="icon-btn" aria-label="Gỡ bình chọn" disabled={busy} onClick={togglePoll}>
                  <Icon name="x" size={20} />
                </button>
              )}
            </div>
            {locked && existingPoll ? (
              <>
                <ul className="poll-editor__locked">
                  {existingPoll.options.map((o) => (
                    <li key={o.id}>{o.text}</li>
                  ))}
                </ul>
                <p className="poll-editor__hint">
                  Đã có {existingPoll.totalVoters} người bình chọn nên không sửa hay gỡ được các lựa chọn. Bạn vẫn sửa được câu hỏi.
                </p>
              </>
            ) : (
              <>
                {options.map((t, i) => (
                  <div key={i} className="poll-editor__row">
                    <input
                      ref={(el) => {
                        optionRefs.current[i] = el;
                      }}
                      className="input"
                      value={t}
                      maxLength={MAX_OPTION_LEN}
                      aria-label={`Lựa chọn ${i + 1}`}
                      aria-invalid={Boolean(pollProblem && (duplicate || filled.length < MIN_OPTIONS))}
                      aria-describedby={pollProblem ? "poll-editor-problem" : undefined}
                      placeholder={`Lựa chọn ${i + 1}`}
                      disabled={busy}
                      onChange={(e) => setOption(i, e.target.value)}
                    />
                    {options.length > MIN_OPTIONS && (
                      <button type="button" className="icon-btn" aria-label={`Bỏ lựa chọn ${i + 1}`} disabled={busy} onClick={() => removeOption(i)}>
                        <Icon name="trash" size={18} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < MAX_OPTIONS && (
                  <button type="button" className="btn btn-ghost poll-editor__add" disabled={busy} onClick={addOption}>
                    <Icon name="plus" size={18} /> Thêm lựa chọn
                  </button>
                )}
                <label className="poll-editor__switch">
                  <span>Cho chọn nhiều</span>
                  <Switch checked={multi} onChange={setMulti} disabled={busy} />
                </label>
                <div className="poll-editor__field">
                  <span id="poll-duration-label" className="field__label">
                    Thời hạn
                  </span>
                  <div className="quick-picks poll-editor__durations" role="group" aria-labelledby="poll-duration-label">
                    {existingPoll && (
                      <button
                        type="button"
                        aria-pressed={duration === 'keep'}
                        className={`quick-pick poll-editor__keep${duration === 'keep' ? ' is-active' : ''}`}
                        disabled={busy}
                        onClick={() => setDuration('keep')}
                      >
                        Giữ nguyên
                      </button>
                    )}
                    {DURATIONS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        aria-pressed={duration === d.value}
                        className={`quick-pick${duration === d.value ? ' is-active' : ''}`}
                        disabled={busy}
                        onClick={() => setDuration(d.value)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <p className="poll-editor__hint">
                    {duration === 'keep'
                      ? existingPoll?.endsAt
                        ? `${existingPoll.closed ? 'Đã kết thúc lúc' : 'Kết thúc lúc'} ${formatDateTime(existingPoll.endsAt)}.`
                        : 'Không giới hạn thời gian.'
                      : duration === 0
                        ? 'Không giới hạn thời gian.'
                        : `Kết thúc sau ${duration} ngày kể từ lúc ${editing ? 'lưu' : 'đăng'}.`}
                  </p>
                </div>
              </>
            )}
            {pollProblem && (
              <p id="poll-editor-problem" className="poll-editor__hint poll-editor__problem" role="status">
                {pollProblem}
              </p>
            )}
          </section>
        )}

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
        <p id={hintId} className="composer__hint">Gõ @ để nhắc tên bạn bè. Tối đa 10 tệp, gồm 1 video MP4/WebM/MOV ≤ 50 MiB; có thể thêm bình chọn.</p>
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
          <button
            type="button"
            className={`tool-btn tool-btn--poll${pollOn ? ' is-on' : ''}`}
            aria-label="Bình chọn"
            aria-pressed={pollOn}
            disabled={busy}
            onClick={togglePoll}
          >
            <Icon name="list" />
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

      <BottomSheet open={leaveOpen} onClose={() => setLeaveOpen(false)} title={editing ? 'Bỏ thay đổi?' : 'Bỏ bài viết?'}>
        <div className="stack">
          <p className="text-muted">{editing ? 'Những thay đổi chưa lưu sẽ mất.' : 'Nội dung bạn vừa viết sẽ không được lưu.'}</p>
          <div className="list">
            <button type="button" className="list__item" onClick={onClose}>
              <span className="list__body">
                <span className="list__label text-danger">{editing ? 'Bỏ thay đổi' : 'Bỏ bài viết'}</span>
              </span>
            </button>
            <button type="button" className="list__item" onClick={() => setLeaveOpen(false)}>
              <span className="list__body">
                <span className="list__label">Tiếp tục chỉnh sửa</span>
              </span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
