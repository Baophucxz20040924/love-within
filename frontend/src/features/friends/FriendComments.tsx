import { useEffect, useId, useRef, useState } from 'react';
import '../stories/form-interactions.css';
import type { FormEvent, ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import type { FriendComment, FriendCommentInput, FriendEventDetail } from '../../lib/types';
import type { FriendCommentPage, FriendCommentContext } from './api';
import { friendCommentsKey, friendEventCommentsKey, friendEventKey, friendEventsApi, friendStoriesApi } from './api';
import { updateFriendStoryInCache } from './cache';
import { MentionField, type MentionSearch } from './MentionField';
import { prefillMention, segments, toPayload, type DraftMention } from './mentions';
import { BlockSheet, ReportSheet, type ReportTargetInfo } from './SafetySheets';
import { useCommentDraft, useCommentDraftDenial } from '../../hooks/useCommentDraft';
import type { CommentDraft } from '../../lib/commentDraftStore';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/**
 * Where the comments live: a post or an event discussion, each with its own mention eligibility. The "bộ hàm API":
 * the same component for both.
 */
export interface CommentApi {
  key: readonly unknown[];
  rootsPage: (cursor?: string, signal?: AbortSignal) => Promise<FriendCommentPage>;
  repliesPage: (rootId: string, cursor?: string, signal?: AbortSignal) => Promise<FriendCommentPage>;
  context: (commentId: string, signal?: AbortSignal) => Promise<FriendCommentContext>;
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
    rootsPage: (cursor, signal) => friendStoriesApi.commentsPage(storyId, cursor, signal),
    repliesPage: (rootId, cursor, signal) => friendStoriesApi.repliesPage(storyId, rootId, cursor, signal),
    context: (commentId, signal) => friendStoriesApi.commentContext(storyId, commentId, signal),
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
    rootsPage: (cursor, signal) => friendEventsApi.commentsPage(eventId, cursor, signal),
    repliesPage: (rootId, cursor, signal) => friendEventsApi.repliesPage(eventId, rootId, cursor, signal),
    context: (commentId, signal) => friendEventsApi.commentContext(eventId, commentId, signal),
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

function PageNav({ older, newer, newest }: { older?: () => void; newer?: () => void; newest?: () => void }) {
  return <nav className="row wrap" aria-label="Trang bình luận">
    {newer && <button type="button" className="btn btn-ghost" onClick={newer}>Mới hơn</button>}
    {older && <button type="button" className="btn btn-ghost" onClick={older}>Cũ hơn</button>}
    {newest && <button type="button" className="btn btn-ghost" onClick={newest}>Mới nhất</button>}
  </nav>;
}

function Replies({ api, scope, rootId, seed, render }: {
  api: CommentApi; scope: string; rootId: string; seed?: FriendCommentPage;
  render: (c: FriendComment, reply: boolean) => ReactNode;
}) {
  // null denotes the notification page, not the newest page (undefined).
  const [cursors, setCursors] = useState<(string | null | undefined)[]>([seed ? null : undefined]);
  const selected = cursors[cursors.length - 1];
  const useSeed = selected === null;
  const cursor = selected ?? undefined;
  const query = useQuery({ queryKey: [...api.key, 'replies', scope, rootId, cursor ?? null],
    queryFn: ({ signal }) => api.repliesPage(rootId, cursor, signal), enabled: !useSeed });
  const data = useSeed ? seed : query.isError ? undefined : query.data;
  return <div className="comment-replies">
    {!useSeed && query.isLoading && <Skeleton height={40} />}
    {!useSeed && query.isError && <p role="status">Không tải được trả lời. <button type="button" onClick={() => void query.refetch()}>Thử lại</button></p>}
    {data?.items.length === 0 && <p className="text-muted text-sm">Không có trả lời trong trang này.</p>}
    {data && [...data.items].reverse().map(c => render(c, true))}
    <PageNav older={data?.nextCursor ? () => setCursors(s => [...s, data.nextCursor!]) : undefined}
      newer={cursors.length > 1 ? () => setCursors(s => s.slice(0, -1)) : undefined}
      newest={useSeed || cursors.length > 1 ? () => setCursors([undefined]) : undefined} />
  </div>;
}

export function FriendComments(props: Props) {
  const { me } = useAuth();
  return <ScopedFriendComments key={`${me?.user.id}:${JSON.stringify(props.api.key)}`} {...props} />;
}

function ScopedFriendComments({ api, focusKey, focusCommentId }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formId = useId();
  const sending = useRef(false);
  const submitted = useRef<CommentDraft | undefined>(undefined);
  const [mentions, setMentions] = useState<DraftMention[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<FriendComment | null>(null);
  const [reporting, setReporting] = useState<ReportTargetInfo | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; displayName: string } | null>(null);
  const focusedOnce = useRef<string | null>(null);
  const [blockedAuthors, setBlockedAuthors] = useState<Set<string>>(() => new Set());
  const visible = (c: FriendComment) => !blockedAuthors.has(c.author.id);

  const key = api.key;
  const scope = me?.user.id ?? '';
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [contextId, setContextId] = useState<string | null>(focusCommentId ?? null);
  const [replyVersion, setReplyVersion] = useState(0);
  useEffect(() => { setContextId(focusCommentId ?? null); focusedOnce.current = null; }, [focusCommentId]);
  const cursor = cursors[cursors.length - 1];
  const comments = useQuery({
    queryKey: [...key, 'page', scope, cursor ?? null],
    queryFn: ({ signal }) => api.rootsPage(cursor, signal),
    enabled: !contextId,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const context = useQuery({ queryKey: [...key, 'context', scope, contextId],
    queryFn: ({ signal }) => api.context(contextId!, signal), enabled: Boolean(contextId),
    refetchInterval: 20_000, refetchOnWindowFocus: true });
  const current = contextId ? context : comments;
  const kind = api.reportType === 'event_comment' ? 'event' : 'story';
  const resourceId = String(api.key[2]);
  const draft = useCommentDraft(kind, resourceId, current.isSuccess && !current.isPlaceholderData);
  const { text, setText } = draft;
  // Restored replies must resolve their original root; never silently post them at the top level.
  const replyContext = useQuery({ queryKey: [...key, 'draft-root', scope, draft.rootId],
    queryFn: ({ signal }) => api.context(draft.rootId!, signal), enabled: draft.ready && !!draft.rootId,
    staleTime: 0, retry: false });
  const replyTo = draft.rootId ? { rootId: draft.rootId, name: replyContext.data?.root.author.displayName ?? 'bình luận đã chọn' } : null;
  const replyReady = !draft.rootId || (replyContext.isSuccess && !replyContext.isFetching && replyContext.data.root.id === draft.rootId);
  const setReplyTo = (target: { rootId: string; name: string } | null) => {
    draft.setText(text, target?.rootId ?? null);
    setMentions([]);
  };
  useCommentDraftDenial(kind, resourceId, comments.error);
  useEffect(() => { if (!draft.ready) setMentions([]); }, [draft.ready]);
  useEffect(() => {
    if (replyContext.error instanceof ApiRequestError && (replyContext.error.status === 403 || replyContext.error.status === 404)) {
      draft.discard();
      setMentions([]);
    }
  }, [replyContext.error]);
  const threads = (current.isError ? [] : contextId ? (context.data ? [context.data.root] : []) : [...(comments.data?.items ?? [])].reverse()).filter(visible);
  const invalidate = () => void qc.invalidateQueries({ queryKey: key, refetchType: 'active' });
  const newest = () => { setContextId(null); setCursors([undefined]); setExpanded(new Set()); };
  const navigate = (next: (string | undefined)[]) => { setCursors(next); setExpanded(new Set()); };

  useEffect(() => {
    if (focusKey > 0) inputRef.current?.focus();
  }, [focusKey]);

  const expand = (rootId: string) => setExpanded((s) => (s.has(rootId) ? s : new Set(s).add(rootId)));

  // From a notification: unfold the thread, scroll to the comment and highlight it for a moment (once per id).
  useEffect(() => {
    if (!contextId || context.isError || focusedOnce.current === contextId || !context.data) return;
    expand(context.data.root.id);
    setHighlight(contextId);
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${contextId}`);
      if (!target) return;
      focusedOnce.current = contextId;
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [contextId, context.data, context.isError, expanded]);

  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const add = useMutation({
    mutationFn: (input: FriendCommentInput) => api.add(input),
    onSuccess: (c) => {
      sending.current = false;
      if (submitted.current && draft.clear(submitted.current)) setMentions([]);
      requestAnimationFrame(() => resize(inputRef.current));
      if (c.parentId) {
        setContextId(c.parentId);
        expand(c.parentId);
        setReplyVersion(v => v + 1);
      } else newest();
      invalidate();
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
      if (contextId === c.id || (!c.parentId && context.data?.root.id === c.id)) newest();
      invalidate();
      if (draft.rootId === c.id) { draft.discard(); setMentions([]); }
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
    const next = c.author.id === me?.user.id || !api.mention ? { text, mentions }
      : api.reportType === 'event_comment' && !c.canMentionAuthor
        ? { text: `${text}${text && !/\s$/.test(text) ? ' ' : ''}@${c.author.displayName} `, mentions }
        : prefillMention(text, mentions, c.author);
    setText(next.text, rootId);
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
    if (!draft.ready || !replyReady || !payload.body || add.isPending || sending.current) return;
    submitted.current = draft.snapshot();
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
  const item = (c: FriendComment, reply: boolean) => visible(c) ? (
    <CommentItem key={c.id} c={c} reply={reply} focused={highlight === c.id} onReply={startReply} onDelete={setToDelete} onReport={report} />
  ) : null;

  return (
    <section className="comments comments--form" aria-label="Bình luận">
      {contextId && <p className="text-muted text-sm">Bình luận từ thông báo <button type="button" className="btn btn-ghost" onClick={newest}>Về danh sách</button></p>}
      {!contextId && cursors.length > 1 && <p className="text-muted text-sm">Đang xem bình luận cũ</p>}
      {current.isLoading && <Skeleton height={56} count={2} />}
      {current.isError && (
        <p className="form-feedback comment-feedback" role="status">
          Không tải được bình luận.{' '}
          <button type="button" className="btn btn-ghost" disabled={current.isFetching} onClick={() => void current.refetch()}>
            {current.isFetching ? 'Đang tải…' : 'Thử lại'}
          </button>
        </p>
      )}
      {current.isSuccess && threads.length === 0 && (
        <p className="text-sm text-muted center">{cursors.length > 1 ? 'Không có bình luận trong trang này.' : 'Chưa có bình luận nào. Hãy là người đầu tiên!'}</p>
      )}
      {threads.map(t => <div key={t.id} className="comment-thread">
        {item(t, false)}
        <button type="button" className="comment-replies__more" aria-expanded={expanded.has(t.id)} onClick={() => setExpanded(s => {
          const next = new Set(s); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next;
        })}>{expanded.has(t.id) ? 'Ẩn trả lời' : 'Xem trả lời'}</button>
        {expanded.has(t.id) && <Replies key={`${t.id}:${replyVersion}:${contextId ?? ''}`} api={api} scope={scope} rootId={t.id}
          seed={contextId ? context.data?.replies : undefined} render={item} />}
      </div>)}
      {!contextId && <PageNav older={!comments.isError && comments.data?.nextCursor ? () => navigate([...cursors, comments.data!.nextCursor!]) : undefined}
        newer={cursors.length > 1 ? () => navigate(cursors.slice(0, -1)) : undefined}
        newest={cursors.length > 1 ? newest : undefined} />}

      <form className={`comment-bar${replyTo ? ' comment-bar--reply' : ''}`} onSubmit={submit}>
        <fieldset className="comment-bar__fields" disabled={add.isPending || !draft.ready} aria-label="Viết bình luận" aria-describedby={`${formId}-hint${add.isError ? ` ${formId}-error` : ''}`}>
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
        <button type="submit" className="icon-btn comment-bar__send" aria-label="Gửi bình luận" disabled={!draft.ready || !replyReady || !text.trim() || add.isPending}>
          {add.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
        </fieldset>
      </form>
      {add.isError && <p ref={errorRef} id={`${formId}-error`} className="form-feedback comment-feedback" role="alert" tabIndex={-1}>{errorText(add.error)} Nội dung vẫn được giữ lại, bạn có thể gửi lại.</p>}
      {replyTo && !replyReady && <p role="status">Chưa xác minh được bình luận gốc. Không gửi nháp thành bình luận mới. <button type="button" className="text-link" onClick={() => void replyContext.refetch()}>Thử lại</button></p>}
      {text && <p className="comment-hint">Nháp được giữ trong tab này tối đa 24 giờ; tag khôi phục là chữ thường, hãy chọn lại nếu cần. <button type="button" className="text-link" disabled={add.isPending} onClick={() => { draft.discard(); setMentions([]); }}>Bỏ nháp</button></p>}
      <p id={`${formId}-hint`} className="comment-hint">Trên máy tính: Enter để gửi, Shift + Enter để xuống dòng.</p>

      <BottomSheet open={toDelete !== null} busy={del.isPending} onClose={() => { if (!del.isPending) setToDelete(null); }} title="Xóa bình luận?">
        <div className="stack">
          <p className="text-muted">
            {toDelete && !toDelete.isMine
              ? `Bình luận của ${toDelete.author.displayName} sẽ bị gỡ khỏi ${api.reportType === 'event_comment' ? 'kèo' : 'bài viết'} của bạn.`
              : 'Bình luận sẽ không còn hiển thị với mọi người.'}
            {toDelete && !toDelete.parentId && ' Các câu trả lời bên dưới cũng bị xóa.'}
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
      <BlockSheet user={blocking} onClose={() => setBlocking(null)} onBlocked={() => {
        if (blocking) setBlockedAuthors(s => new Set(s).add(blocking.id));
        setExpanded(new Set());
        draft.discard();
        setMentions([]);
        invalidate();
      }} />
    </section>
  );
}
