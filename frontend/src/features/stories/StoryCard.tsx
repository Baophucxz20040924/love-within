import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { GalleryViewer } from '../../components/GalleryViewer';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useAvatarOf } from '../auth/useAvatarOf';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDateTime, formatDay, localDateOf, shortName, timeAgo } from '../../lib/format';
import type { ReactionType, Story, StoryReactor } from '../../lib/types';
import { STORY_UNREAD_KEY, storiesApi } from './api';
import { removeStoryFromCache, replaceStoryInCache, updateStoryInCache } from './cache';
import { moodOf, reactionOf } from './constants';
import { PhotoGrid } from './PhotoGrid';
import { PostVideo } from './PostVideo';
import { ReactionButton } from './ReactionButton';
import { ReactionPeople } from './ReactionPeople';

interface Props {
  story: Story;
  /** Partner's post published since my last visit. */
  isNew?: boolean;
  /** Feed: clamp long text with "Xem thêm". Detail page: show everything. */
  clamp?: boolean;
  onEdit: (story: Story) => void;
  /** Called after the post is deleted (detail page navigates back). */
  onDeleted?: () => void;
  /** Feed: link to the detail page. Detail page: focus the comment box. */
  onComment?: () => void;
}

function ReactionSummary({ story, onOpen }: { story: Story; onOpen: () => void }) {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const { mine, partner: theirs } = story.reactions;
  if (!mine && !theirs) return <span />;
  const types = [...new Set([mine, theirs].filter((t): t is ReactionType => Boolean(t)))];
  const partnerName = partner ? shortName(partner.displayName) : 'Người ấy';
  const who = mine && theirs ? `Bạn và ${partnerName}` : mine ? 'Bạn' : partnerName;
  return (
    <button type="button" className="post__reactions" aria-label="Xem người đã thả cảm xúc" onClick={onOpen}>
      <span className="reaction-stack" aria-hidden="true">
        {types.map((t) => (
          <span key={t} className="reaction-stack__item">
            {reactionOf(t).emoji}
          </span>
        ))}
      </span>
      <span>{who}</span>
    </button>
  );
}

export function StoryCard({ story, isNew = false, clamp = true, onEdit, onDeleted, onComment }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const avatarOf = useAvatarOf();
  const tz = me?.couple?.timezone ?? 'Asia/Ho_Chi_Minh';
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [gallery, setGallery] = useState<number | null>(null);

  const mood = moodOf(story.mood);
  const isLong = story.body.length > 280 || story.body.split('\n').length > 5;
  const isShortText = story.photos.length === 0 && !story.videos?.length && story.body.length > 0 && story.body.length <= 85 && !story.body.includes('\n');
  const memoryDay = story.happenedOn !== localDateOf(story.createdAt, tz) ? story.happenedOn : null;
  const partner = me?.couple?.members.find((member) => member.id !== me.user.id);
  const people: StoryReactor[] = [];
  if (me && story.reactions.mine) people.push({ id: me.user.id, displayName: me.user.displayName, avatarUrl: avatarOf(me.user.id), type: story.reactions.mine });
  if (partner && story.reactions.partner) people.push({ id: partner.id, displayName: partner.displayName, avatarUrl: avatarOf(partner.id), type: story.reactions.partner });

  const react = useMutation({
    mutationFn: (type: ReactionType | null) => (type ? storiesApi.react(story.id, type) : storiesApi.unreact(story.id)),
    onMutate: (type) => updateStoryInCache(qc, story.id, (s) => ({ ...s, reactions: { ...s.reactions, mine: type } })),
    onSuccess: (s) => replaceStoryInCache(qc, s),
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Không thả được cảm xúc, thử lại nhé.');
      void qc.invalidateQueries({ queryKey: ['stories'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => storiesApi.remove(story.id),
    onSuccess: () => {
      setConfirmDelete(false);
      removeStoryFromCache(qc, story.id);
      void qc.invalidateQueries({ queryKey: STORY_UNREAD_KEY });
      toast.info('Đã xóa bài viết');
      onDeleted?.();
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Không xóa được, thử lại nhé.'),
  });

  return (
    <article className="post" aria-label={`Bài viết của ${story.author.displayName}`}>
      <header className="post__head">
        <Avatar name={story.author.displayName} src={avatarOf(story.author.id)} size={42} />
        <div className="post__who">
          <p className="post__name">
            <strong>{story.isMine ? me?.user.displayName : story.author.displayName}</strong>
            {mood && (
              <span className="post__mood">
                {' '}
                đang cảm thấy {mood.emoji} <strong>{mood.label}</strong>
              </span>
            )}
          </p>
          <p className="post__meta">
            {isNew && <span className="chip chip--brand post__new">Mới</span>}
            <Link to={`/stories/${story.id}`} className="post__time">
              {timeAgo(story.createdAt)}
            </Link>
            <span aria-hidden="true"> · </span>
            <Icon name="lock" size={12} />
            <span className="visually-hidden">Chỉ hai bạn</span>
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
        {story.isMine && (
          <button type="button" className="icon-btn" aria-label="Tùy chọn bài viết" onClick={() => setMenuOpen(true)}>
            <Icon name="moreHorizontal" />
          </button>
        )}
      </header>

      {memoryDay && (
        <p className="post__memory">
          <Icon name="calendar" size={14} /> Kỷ niệm ngày {formatDay(memoryDay)}
        </p>
      )}

      {story.body && (
        <div className={`post__body${isShortText ? ' post__body--big' : ''}`}>
          <p className={clamp && isLong && !expanded ? 'is-clamped' : undefined}>{story.body}</p>
          {clamp && isLong && !expanded && (
            <button type="button" className="post__more" onClick={() => setExpanded(true)}>
              Xem thêm
            </button>
          )}
        </div>
      )}

      <PhotoGrid photos={story.photos} onOpen={setGallery} />
      {(story.videos ?? []).map((video) => <PostVideo key={video.key} src={video.url} />)}

      {(story.reactions.mine || story.reactions.partner || story.commentCount > 0) && (
        <div className="post__stats">
          <ReactionSummary story={story} onOpen={() => setReactionsOpen(true)} />
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

      <BottomSheet open={reactionsOpen} onClose={() => setReactionsOpen(false)} title="Người đã thả cảm xúc">
        {people.length ? <ReactionPeople people={people} myId={me?.user.id} /> : <p className="text-muted">Chưa có ai để hiện ở đây.</p>}
      </BottomSheet>

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Bài viết của bạn">
        <div className="list">
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setMenuOpen(false);
              onEdit(story);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="edit" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Chỉnh sửa bài viết</span>
            </span>
          </button>
          <button
            type="button"
            className="list__item"
            onClick={() => {
              setMenuOpen(false);
              setConfirmDelete(true);
            }}
          >
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="trash" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label text-danger">Xóa bài viết</span>
            </span>
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Xóa bài viết?">
        <div className="stack">
          <p className="text-muted">Bài viết, cảm xúc và bình luận sẽ không còn hiển thị với cả hai bạn.</p>
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

      <GalleryViewer urls={story.photos.map((p) => p.url)} index={gallery} onClose={() => setGallery(null)} />
    </article>
  );
}
