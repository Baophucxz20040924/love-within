import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { GalleryViewer } from '../../components/GalleryViewer';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDateTime, shortName, timeAgo } from '../../lib/format';
import type { FriendStory, ReactionType } from '../../lib/types';
import { PhotoGrid } from '../stories/PhotoGrid';
import { PostVideo } from '../stories/PostVideo';
import { ReactionButton } from '../stories/ReactionButton';
import { reactionOf } from '../stories/constants';
import { friendStoriesApi } from './api';
import { removeFriendStoryFromCache, replaceFriendStoryInCache, updateFriendStoryInCache } from './cache';
import { FriendPollView } from './FriendPoll';
import { segments } from './mentions';
import { BlockSheet, ReportSheet, type ReportTargetInfo } from './SafetySheets';

interface Props {
  story: FriendStory;
  /** Feed: clamp long text with "Xem thêm". Detail page: show everything. */
  clamp?: boolean;
  onEdit: (story: FriendStory) => void;
  /** The post left my view (deleted, hidden, author blocked): the detail page navigates back. */
  onDeleted?: () => void;
  /** Feed: open the detail page. Detail page: focus the comment box. */
  onComment?: () => void;
}

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** "Bạn và 3 người khác" / "Bạn" / "4" next to the reaction emojis, like Facebook. */
function ReactionSummary({ story }: { story: FriendStory }) {
  const { mine, total, top } = story.reactions;
  if (total === 0) return <span />;
  const who = mine ? (total > 1 ? `Bạn và ${total - 1} người khác` : 'Bạn') : String(total);
  return (
    <span className="post__reactions">
      <span className="reaction-stack" aria-hidden="true">
        {top.map((t) => (
          <span key={t} className="reaction-stack__item">
            {reactionOf(t).emoji}
          </span>
        ))}
      </span>
      <span>{who}</span>
    </span>
  );
}

/** Optimistic reaction change: my reaction, total and the emoji stack. The server answer replaces it. */
function withMyReaction(s: FriendStory, type: ReactionType | null): FriendStory {
  const { mine, total, top } = s.reactions;
  const nextTotal = total + (type && !mine ? 1 : 0) - (!type && mine ? 1 : 0);
  const nextTop = type && !top.includes(type) ? [type, ...top].slice(0, 3) : nextTotal === 0 ? [] : top;
  return { ...s, reactions: { mine: type, total: nextTotal, top: nextTop } };
}

export function FriendStoryCard({ story, clamp = true, onEdit, onDeleted, onComment }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [gallery, setGallery] = useState<number | null>(null);
  const [reporting, setReporting] = useState<ReportTargetInfo | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; displayName: string } | null>(null);

  const author = story.author;
  const profileUrl = `/friends/u/${author.id}`;
  const isLong = story.body.length > 280 || story.body.split('\n').length > 5;
  const isShortText = story.photos.length === 0 && !story.videos?.length && story.body.length > 0 && story.body.length <= 85 && !story.body.includes('\n');

  const react = useMutation({
    mutationFn: (type: ReactionType | null) => (type ? friendStoriesApi.react(story.id, type) : friendStoriesApi.unreact(story.id)),
    onMutate: (type) => updateFriendStoryInCache(qc, story.id, (s) => withMyReaction(s, type)),
    onSuccess: (s) => replaceFriendStoryInCache(qc, s),
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Không thả được cảm xúc, thử lại nhé.');
      void qc.invalidateQueries({ queryKey: ['friends'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => friendStoriesApi.remove(story.id),
    onSuccess: () => {
      setConfirmDelete(false);
      removeFriendStoryFromCache(qc, story.id);
      toast.info('Đã xóa bài viết');
      onDeleted?.();
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Không xóa được, thử lại nhé.'),
  });

  const hide = useMutation({
    mutationFn: () => friendStoriesApi.hide(story.id),
    onSuccess: () => {
      removeFriendStoryFromCache(qc, story.id);
      toast.info('Đã ẩn bài viết khỏi bảng tin của bạn');
      onDeleted?.();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  function menuItem(icon: 'edit' | 'trash' | 'eyeOff' | 'alert' | 'shield', label: string, onClick: () => void, danger = false) {
    return (
      <button
        type="button"
        className="list__item"
        onClick={() => {
          setMenuOpen(false);
          onClick();
        }}
      >
        <span className="icon-tile icon-tile--neutral" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <span className="list__body">
          <span className={`list__label${danger ? ' text-danger' : ''}`}>{label}</span>
        </span>
      </button>
    );
  }

  return (
    <article className="post" aria-label={`Bài viết của ${author.displayName}`}>
      <header className="post__head">
        <Link to={profileUrl} className="post__avatar-link" tabIndex={-1} aria-hidden="true">
          <Avatar name={author.displayName} src={author.avatarUrl} size={42} />
        </Link>
        <div className="post__who">
          <p className="post__name">
            <Link to={profileUrl} className="post__name-link">
              <strong>{author.displayName}</strong>
            </Link>
          </p>
          <p className="post__meta">
            <Link to={`/friends/posts/${story.id}`} className="post__time">
              {timeAgo(story.createdAt)}
            </Link>
            <span aria-hidden="true"> · </span>
            <Icon name="users" size={12} />
            <span className="visually-hidden">Bạn bè</span>
            {story.editedAt && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="post__edited" title={`Đã chỉnh sửa ${formatDateTime(story.editedAt)}`}>
                  Đã chỉnh sửa
                </span>
              </>
            )}
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label="Tùy chọn bài viết" onClick={() => setMenuOpen(true)}>
          <Icon name="moreHorizontal" />
        </button>
      </header>

      {story.body && (
        <div className={`post__body${isShortText ? ' post__body--big' : ''}`}>
          <p className={clamp && isLong && !expanded ? 'is-clamped' : undefined}>
            {segments(story.body, story.mentions ?? []).map((part, i) => part.userId ? (
              <Link key={i} to={`/friends/u/${part.userId}`} className="mention">{part.text}</Link>
            ) : part.text)}
          </p>
          {clamp && isLong && !expanded && (
            <button type="button" className="post__more" onClick={() => setExpanded(true)}>
              Xem thêm
            </button>
          )}
        </div>
      )}

      {story.poll && <FriendPollView story={story} poll={story.poll} />}

      <PhotoGrid photos={story.photos} onOpen={setGallery} />
      {(story.videos ?? []).map((video) => <PostVideo key={video.key} src={video.url} />)}

      {(story.reactions.total > 0 || story.commentCount > 0) && (
        <div className="post__stats">
          <ReactionSummary story={story} />
          {story.commentCount > 0 && (
            <button type="button" className="post__stat-link" onClick={onComment}>
              {story.commentCount} bình luận
            </button>
          )}
        </div>
      )}

      <div className="post__actions">
        <ReactionButton mine={story.reactions.mine} onReact={(t) => react.mutate(t)} />
        <button type="button" className="post-action" onClick={onComment}>
          <Icon name="messageCircle" size={20} />
          <span>Bình luận</span>
        </button>
      </div>

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={story.isMine ? 'Bài viết của bạn' : `Bài viết của ${shortName(author.displayName)}`}>
        <div className="list">
          {story.isMine ? (
            <>
              {menuItem('edit', 'Chỉnh sửa bài viết', () => onEdit(story))}
              {menuItem('trash', 'Xóa bài viết', () => setConfirmDelete(true), true)}
            </>
          ) : (
            <>
              {menuItem('eyeOff', 'Ẩn bài viết', () => hide.mutate())}
              {menuItem('alert', 'Báo cáo bài viết', () => setReporting({ type: 'story', id: story.id, owner: author }))}
              {menuItem('shield', `Chặn ${shortName(author.displayName)}`, () => setBlocking(author), true)}
            </>
          )}
        </div>
      </BottomSheet>

      <BottomSheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Xóa bài viết?">
        <div className="stack">
          <p className="text-muted">
            {story.poll ? 'Bài viết, bình chọn, cảm xúc và bình luận' : 'Bài viết, cảm xúc và bình luận'} sẽ không còn hiển thị với bạn bè.
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Hủy
            </button>
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Xóa
            </button>
          </div>
        </div>
      </BottomSheet>

      <ReportSheet target={reporting} onClose={() => setReporting(null)} onBlock={setBlocking} onHide={() => hide.mutate()} />
      <BlockSheet user={blocking} onClose={() => setBlocking(null)} onBlocked={() => onDeleted?.()} />

      <GalleryViewer urls={story.photos.map((p) => p.url)} index={gallery} onClose={() => setGallery(null)} />
    </article>
  );
}
