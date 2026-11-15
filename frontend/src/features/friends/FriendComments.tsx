import { useEffect, useId, useRef, useState } from 'react';
import '../stories/form-interactions.css';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/StatusViews';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../../lib/apiClient';
import { timeAgo } from '../../lib/format';
import type { FriendComment, FriendCommentInput, FriendCommentThread, FriendEventDetail } from '../../lib/types';
import { friendCommentsKey, friendEventCommentsKey, friendEventKey, friendEventsApi, friendStoriesApi } from './api';
import { updateFriendStoryInCache } from './cache';
import { MentionField, type MentionSearch } from './MentionField';
import { prefillMention, segments, toPayload, type DraftMention } from './mentions';
import { BlockSheet, ReportSheet, type ReportTargetInfo } from './SafetySheets';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');
/** More replies than this under one comment: folded behind "Xem N câu trả lời" (plan BB8). */
const SHOWN_REPLIES = 2;

/**
 * Where the comments live: a post or an event discussion, each with its own mention eligibility. The "bộ hàm API":
 * the same component for both.
 */
export interface CommentApi {
  key: readonly unknown[];
  list: () => Promise<FriendCommentThread[]>;
  add: (input: FriendCommentInput) => Promise<FriendComment>;
  remove: (commentId: string) => Promise<{ removed: number }>;
  /** "@" picker; left out = plain box. */
  mention?: MentionSearch;
  reportType: 'comment' | 'event_comment';
  /** The post's or event's comment count changed by `delta`. */
  onCount: (qc: QueryClient, delta: number) => void;
}

export function storyCommentApi(storyId: string): CommentApi {
  return {
    key: friendCommentsKey(storyId),
    list: () => friendStoriesApi.comments(storyId),
    add: (input) => friendStoriesApi.addComment(storyId, input),
    remove: (commentId) => friendStoriesApi.deleteComment(storyId, commentId),
    mention: { id: storyId, fn: (q) => friendStoriesApi.mentionable(storyId, q) },
    reportType: 'comment',
    onCount: (qc, delta) => updateFriendStoryInCache(qc, storyId, (s) => ({ ...s, commentCount: Math.max(0, s.commentCount + delta) })),
  };
}

export function eventCommentApi(eventId: string): CommentApi {
  return {
    key: friendEventCommentsKey(eventId),
    list: () => friendEventsApi.comments(eventId),
    add: (input) => friendEventsApi.addComment(eventId, input),
    remove: (commentId) => friendEventsApi.deleteComment(eventId, commentId),
    mention: { id: eventId, resource: 'event', fn: (q) => friendEventsApi.mentionable(eventId, q) },
    reportType: 'event_comment',
    onCount: (qc, delta) =>
      qc.setQueryData<FriendEventDetail>(friendEventKey(eventId), (e) => (e ? { ...e, commentCount: Math.max(0, e.commentCount + delta) } : e)),
  };
}

function resize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
}

/** Comment text with "@Tên" as a bold link to the profile (people the server left out stay plain text). */
function CommentBody({ c }: { c: FriendComment }) {
  return (
    <p className="comment__body">
      {segments(c.body, c.mentions).map((s, i) =>
        s.userId ? (
          <Link key={i} to={`/friends/u/${s.userId}`} className="mention">
            {s.text.replace(/^@/, '')}
          </Link>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

interface ItemProps {
  c: FriendComment;
  reply?: boolean;
  focused: boolean;
  onReply: (c: FriendComment) => void;
  onDelete: (c: FriendComment) => void;
  onReport: (c: FriendComment) => void;
}

function CommentItem({ c, reply = false, focused, onReply, onDelete, onReport }: ItemProps) {
  return (
    <div id={`comment-${c.id}`} className={`comment${reply ? ' comment--reply' : ''}${focused ? ' comment--focus' : ''}`}>
      <Link to={`/friends/u/${c.author.id}`} tabIndex={-1} aria-hidden="true">
        <Avatar name={c.author.displayName} src={c.author.avatarUrl} size={reply ? 28 : 34} />
      </Link>
      <div className="comment__main">
        <div className="comment__bubble">
          <Link to={`/friends/u/${c.author.id}`} className="comment__name comment__name-link">
            {c.author.displayName}
          </Link>
          <CommentBody c={c} />
        </div>
        <div className="comment__meta">
          <span>{timeAgo(c.createdAt)}</span>
          <button type="button" className="comment__action" onClick={() => onReply(c)}>
            Trả lời
          </button>
          {c.canDelete && (
            <button type="button" className="comment__action" onClick={() => onDelete(c)}>
              Xóa
            </button>
          )}
          {!c.isMine && (
            <button type="button" className="comment__action" onClick={() => onReport(c)}>
              Báo cáo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface Props {
  api: CommentApi;
  /** Increment to focus the input (the post's "Bình luận" button). */
  focusKey: number;
  /** Open at this comment (from a notification): its replies unfold and it is scrolled to and highlighted. */
  focusCommentId?: string | null;
}

export function FriendComments({ api, focusKey, focusCommentId }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formId = useId();
  const sending = useRef(false);
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<DraftMention[]>([]);
  const [replyTo, setReplyTo] = useState<{ rootId: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<FriendComment | null>(null);
  const [reporting, setReporting] = useState<ReportTargetInfo | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; displayName: string } | null>(null);
  const focusedOnce = useRef<string | null>(null);

  const key = api.key;
  const comments = useQuery({
    queryKey: key,
    queryFn: api.list,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const threads = comments.data ?? [];

  useEffect(() => {
    if (focusKey > 0) inputRef.current?.focus();
  }, [focusKey]);

  const expand = (rootId: string) => setExpanded((s) => (s.has(rootId) ? s : new Set(s).add(rootId)));

  // From a notification: unfold the thread, scroll to the comment and highlight it for a moment (once per id).
  useEffect(() => {
    if (!focusCommentId || focusedOnce.current === focusCommentId || !comments.data) return;
    const thread = comments.data.find((t) => t.id === focusCommentId || t.replies.some((r) => r.id === focusCommentId));
    if (!thread) return;
    expand(thread.id);
    setHighlight(focusCommentId);
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${focusCommentId}`);
      if (!target) return;
      focusedOnce.current = focusCommentId;
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCommentId, comments.data, comments.dataUpdatedAt]);

  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const add = useMutation({
    mutationFn: (input: FriendCommentInput) => api.add(input),
    onSuccess: (c) => {
      sending.current = false;
      setText('');
      setMentions([]);
      setReplyTo(null);
      requestAnimationFrame(() => resize(inputRef.current));
      qc.setQueryData<FriendCommentThread[]>(key, (list) => {
        const items = list ?? [];
        if (!c.parentId) return [...items, { ...c, replies: [] }];
        return items.map((t) => (t.id === c.parentId ? { ...t, replies: [...t.replies, c] } : t));
      });
      if (c.parentId) expand(c.parentId);
      api.onCount(qc, 1);
    },
    onError: () => { sending.current = false; },
  });

  useEffect(() => {
    if (add.isError) {
      errorRef.current?.focus({ preventScroll: true });
      errorRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [add.isError, add.error]);

  const del = useMutation({
    mutationFn: (c: FriendComment) => api.remove(c.id),
    onSuccess: (res, c) => {
      setToDelete(null);
      qc.setQueryData<FriendCommentThread[]>(key, (list) =>
        c.parentId
          ? list?.map((t) => (t.id === c.parentId ? { ...t, replies: t.replies.filter((r) => r.id !== c.id) } : t))
          : list?.filter((t) => t.id !== c.id),
      );
      setReplyTo((r) => (r && r.rootId === c.id ? null : r));
      api.onCount(qc, -(res.removed ?? 1));
      toast.info('Đã xóa bình luận');
    },
    onError: (err) => toast.error(errorText(err)),
  });

  /** "Trả lời": goes under the root comment; answering someone else starts with "@Tên" (only where names are allowed). */
  function startReply(c: FriendComment) {
    if (sending.current) return;
    const rootId = c.parentId ?? c.id;
    expand(rootId);
    setReplyTo({ rootId, name: c.author.displayName });
    const next = c.author.id === me?.user.id || !api.mention ? { text, mentions }
      : api.reportType === 'event_comment' && !c.canMentionAuthor
        ? { text: `${text}${text && !/\s$/.test(text) ? ' ' : ''}@${c.author.displayName} `, mentions }
        : prefillMention(text, mentions, c.author);
    setText(next.text);
    setMentions(next.mentions);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.text.length, next.text.length);
      resize(el);
    });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const payload = toPayload(text, mentions);
    if (!payload.body || add.isPending || sending.current) return;
    sending.current = true;
    add.mutate({ ...payload, ...(replyTo ? { parentId: replyTo.rootId } : {}) });
  }

  // Desktop: Enter sends, Shift+Enter adds a line (like facebook.com). Phones: Enter adds a line.
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  }

  const report = (c: FriendComment) => setReporting({ type: api.reportType, id: c.id, owner: c.author });
  const item = (c: FriendComment, reply: boolean) => (
    <CommentItem key={c.id} c={c} reply={reply} focused={highlight === c.id} onReply={startReply} onDelete={setToDelete} onReport={report} />
  );
  const deletingReplies = toDelete && !toDelete.parentId ? (threads.find((t) => t.id === toDelete.id)?.replies.length ?? 0) : 0;

  return (
    <section className="comments comments--form" aria-label="Bình luận">
      {comments.isLoading && <Skeleton height={56} count={2} />}
      {comments.isError && (
        <p className="form-feedback comment-feedback" role="status">
          Không tải được bình luận.{' '}
          <button type="button" className="btn btn-ghost" disabled={comments.isFetching} onClick={() => void comments.refetch()}>
            {comments.isFetching ? 'Đang tải…' : 'Thử lại'}
          </button>
        </p>
      )}
      {comments.isSuccess && threads.length === 0 && (
        <p className="text-sm text-muted center">Chưa có bình luận nào. Hãy là người đầu tiên!</p>
      )}
      {threads.map((t) => {
        const folded = t.replies.length > SHOWN_REPLIES && !expanded.has(t.id);
        return (
          <div key={t.id} className="comment-thread">
            {item(t, false)}
            {t.replies.length > 0 && (
              <div className="comment-replies">
                {folded ? (
                  <button type="button" className="comment-replies__more" aria-expanded="false" onClick={() => expand(t.id)}>
                    <Icon name="cornerDownRight" size={16} />
                    Xem {t.replies.length} câu trả lời
                  </button>
                ) : (
                  t.replies.map((r) => item(r, true))
                )}
              </div>
            )}
          </div>
        );
      })}

      <form className={`comment-bar${replyTo ? ' comment-bar--reply' : ''}`} onSubmit={submit}>
        <fieldset className="comment-bar__fields" disabled={add.isPending} aria-label="Viết bình luận" aria-describedby={`${formId}-hint${add.isError ? ` ${formId}-error` : ''}`}>
        {replyTo && (
          <div className="comment-bar__replying">
            <span>
              Đang trả lời <strong>{replyTo.name}</strong>
            </span>
            <button type="button" className="comment__action" onClick={() => setReplyTo(null)}>
              Hủy
            </button>
          </div>
        )}
        <Avatar name={me?.user.displayName ?? ''} src={me?.user.avatarUrl} size={32} />
        <MentionField
          search={api.mention}
          text={text}
          mentions={mentions}
          onChange={(nextText, nextMentions) => {
            if (sending.current) return;
            setText(nextText);
            setMentions(nextMentions);
          }}
          inputRef={inputRef}
          placeholder={replyTo ? `Trả lời ${replyTo.name}…` : 'Viết bình luận…'}
          onKeyDown={onKeyDown}
          onInput={resize}
        />
        <button type="submit" className="icon-btn comment-bar__send" aria-label="Gửi bình luận" disabled={!text.trim() || add.isPending}>
          {add.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
        </fieldset>
      </form>
      {add.isError && <p ref={errorRef} id={`${formId}-error`} className="form-feedback comment-feedback" role="alert" tabIndex={-1}>{errorText(add.error)} Nội dung vẫn được giữ lại, bạn có thể gửi lại.</p>}
      <p id={`${formId}-hint`} className="comment-hint">Trên máy tính: Enter để gửi, Shift + Enter để xuống dòng.</p>

      <BottomSheet open={toDelete !== null} busy={del.isPending} onClose={() => { if (!del.isPending) setToDelete(null); }} title="Xóa bình luận?">
        <div className="stack">
          <p className="text-muted">
            {toDelete && !toDelete.isMine
              ? `Bình luận của ${toDelete.author.displayName} sẽ bị gỡ khỏi ${api.reportType === 'event_comment' ? 'kèo' : 'bài viết'} của bạn.`
              : 'Bình luận sẽ không còn hiển thị với mọi người.'}
            {deletingReplies > 0 && ` ${deletingReplies} câu trả lời bên dưới cũng bị xóa.`}
          </p>
          {del.isError && <p className="form-feedback" role="alert">{errorText(del.error)}</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={del.isPending} onClick={() => setToDelete(null)}>
              Hủy
            </button>
            <button type="button" className="btn btn-danger" disabled={del.isPending} onClick={() => toDelete && del.mutate(toDelete)}>
              Xóa
            </button>
          </div>
        </div>
      </BottomSheet>

      <ReportSheet target={reporting} onClose={() => setReporting(null)} onBlock={setBlocking} />
      <BlockSheet user={blocking} onClose={() => setBlocking(null)} onBlocked={() => void comments.refetch()} />
    </section>
  );
}
