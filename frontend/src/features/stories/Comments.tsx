import { useEffect, useId, useRef, useState } from 'react';
import '../stories/form-interactions.css';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/StatusViews';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useAvatarOf } from '../auth/useAvatarOf';
import { ApiRequestError } from '../../lib/apiClient';
import { timeAgo } from '../../lib/format';
import type { StoryComment } from '../../lib/types';
import { storiesApi, storyCommentsKey } from './api';
import { updateStoryInCache } from './cache';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

function resize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
}

interface Props {
  storyId: string;
  /** Increment to focus the input (the post's "Bình luận" button). */
  focusKey: number;
}

export function CommentSection({ storyId, focusKey }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const avatarOf = useAvatarOf();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formId = useId();
  const sending = useRef(false);
  const [text, setText] = useState('');
  const [toDelete, setToDelete] = useState<StoryComment | null>(null);

  const comments = useQuery({
    queryKey: storyCommentsKey(storyId),
    queryFn: () => storiesApi.comments(storyId),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (focusKey > 0) inputRef.current?.focus();
  }, [focusKey]);

  const add = useMutation({
    mutationFn: (body: string) => storiesApi.addComment(storyId, body),
    onSuccess: (c) => {
      sending.current = false;
      setText('');
      requestAnimationFrame(() => resize(inputRef.current));
      qc.setQueryData<StoryComment[]>(storyCommentsKey(storyId), (list) => [...(list ?? []), c]);
      updateStoryInCache(qc, storyId, (s) => ({ ...s, commentCount: s.commentCount + 1 }));
    },
    onError: () => { sending.current = false; },
  });

  useEffect(() => {
    if (add.isError) errorRef.current?.focus();
  }, [add.isError, add.error]);

  const del = useMutation({
    mutationFn: (id: string) => storiesApi.deleteComment(storyId, id),
    onSuccess: (_r, id) => {
      setToDelete(null);
      qc.setQueryData<StoryComment[]>(storyCommentsKey(storyId), (list) => list?.filter((c) => c.id !== id));
      updateStoryInCache(qc, storyId, (s) => ({ ...s, commentCount: Math.max(0, s.commentCount - 1) }));
      toast.info('Đã xóa bình luận');
    },
    onError: (err) => toast.error(errorText(err)),
  });

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || add.isPending || sending.current) return;
    sending.current = true;
    add.mutate(body);
  }

  // Desktop: Enter sends, Shift+Enter adds a line (like facebook.com). Phones: Enter adds a line.
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section className="comments comments--form" aria-label="Bình luận">
      {comments.isLoading && <Skeleton height={56} count={2} />}
      {comments.isError && (
        <div className="form-feedback comment-feedback" role="status">
          Không tải được bình luận.{' '}
          <button type="button" className="btn btn-ghost" disabled={comments.isFetching} onClick={() => void comments.refetch()}>
            {comments.isFetching ? 'Đang tải…' : 'Thử lại'}
          </button>
        </div>
      )}
      {comments.isSuccess && comments.data.length === 0 && (
        <p className="text-sm text-muted center">Chưa có bình luận nào. Hãy là người đầu tiên!</p>
      )}
      {comments.data?.map((c) => (
        <div key={c.id} className="comment">
          <Avatar name={c.author.displayName} src={avatarOf(c.author.id)} size={34} />
          <div className="comment__main">
            <div className="comment__bubble">
              <p className="comment__name">{c.author.displayName}</p>
              <p className="comment__body">{c.body}</p>
            </div>
            <div className="comment__meta">
              <span>{timeAgo(c.createdAt)}</span>
              {c.isMine && (
                <button type="button" className="comment__action" onClick={() => setToDelete(c)}>
                  Xóa
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      <form className="comment-bar" onSubmit={submit}>
        <Avatar name={me?.user.displayName ?? ''} src={me?.user.avatarUrl} size={32} />
        <textarea
          ref={inputRef}
          className="comment-bar__input"
          rows={1}
          readOnly={add.isPending}
          aria-invalid={add.isError}
          aria-describedby={`${formId}-hint${add.isError ? ` ${formId}-error` : ''}`}
          value={text}
          maxLength={2000}
          placeholder="Viết bình luận…"
          aria-label="Viết bình luận"
          onChange={(e) => {
            setText(e.target.value);
            resize(e.target);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="icon-btn comment-bar__send" aria-label="Gửi bình luận" disabled={!text.trim() || add.isPending}>
          {add.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
      </form>
      {add.isError && <p ref={errorRef} id={`${formId}-error`} className="form-feedback comment-feedback" role="alert" tabIndex={-1}>{errorText(add.error)} Nội dung vẫn được giữ lại, bạn có thể gửi lại.</p>}
      <p id={`${formId}-hint`} className="comment-hint">Trên máy tính: Enter để gửi, Shift + Enter để xuống dòng.</p>

      <BottomSheet open={toDelete !== null} busy={del.isPending} onClose={() => { if (!del.isPending) setToDelete(null); }} title="Xóa bình luận?">
        <div className="stack">
          <p className="text-muted">Bình luận sẽ không còn hiển thị với cả hai bạn.</p>
          {del.isError && <p className="form-feedback" role="alert">{errorText(del.error)}</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={del.isPending} onClick={() => setToDelete(null)}>
              Hủy
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={del.isPending}
              onClick={() => toDelete && del.mutate(toDelete.id)}
            >
              Xóa
            </button>
          </div>
        </div>
      </BottomSheet>
    </section>
  );
}
