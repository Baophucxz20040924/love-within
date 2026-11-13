import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { ErrorState, Skeleton } from '../../components/StatusViews';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import type { FriendPoll as Poll, FriendStory } from '../../lib/types';
import { friendStoriesApi, pollVotersKey } from './api';
import { replaceFriendStoryInCache, updateFriendStoryInCache } from './cache';

const HOUR_MS = 3_600_000;

/** "Còn 3 ngày" / "Còn 5 giờ" / "Còn ít phút" before the deadline. */
function timeLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms >= 24 * HOUR_MS) return `Còn ${Math.floor(ms / (24 * HOUR_MS))} ngày`;
  if (ms >= HOUR_MS) return `Còn ${Math.floor(ms / HOUR_MS)} giờ`;
  return 'Còn ít phút';
}

/** My new choice, applied at once (the server answer replaces it). */
function withMyVote(p: Poll, next: string[]): Poll {
  const had = p.mine.length > 0;
  const has = next.length > 0;
  return {
    ...p,
    mine: next,
    totalVoters: p.totalVoters + (has && !had ? 1 : 0) - (!has && had ? 1 : 0),
    options: p.options.map((o) => ({
      ...o,
      count: o.count + (next.includes(o.id) ? 1 : 0) - (p.mine.includes(o.id) ? 1 : 0),
    })),
  };
}

const pct = (count: number, total: number) => (total > 0 ? Math.round((count / total) * 100) : 0);

interface Props {
  story: FriendStory;
  poll: Poll;
}

/**
 * Poll of a friends post (BB6): one bar per option with %, count and voter faces; results are always shown. Tap to
 * choose, change or take back (single choice: radio; "Cho chọn nhiều": checkboxes). After the deadline the bars are
 * locked and the option(s) with the most votes are marked.
 */
export function FriendPollView({ story, poll }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [voters, setVoters] = useState<{ id: string; text: string } | null>(null);

  const vote = useMutation({
    mutationFn: (next: string[]) => (next.length ? friendStoriesApi.vote(story.id, next) : friendStoriesApi.unvote(story.id)),
    onMutate: (next) => updateFriendStoryInCache(qc, story.id, (s) => (s.poll ? { ...s, poll: withMyVote(s.poll, next) } : s)),
    onSuccess: (s) => {
      replaceFriendStoryInCache(qc, s);
      void qc.invalidateQueries({ queryKey: ['friends', 'poll-voters', story.id] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Chưa bình chọn được, thử lại nhé.');
      void qc.invalidateQueries({ queryKey: ['friends'] });
    },
  });

  const maxCount = Math.max(0, ...poll.options.map((o) => o.count));
  const isTop = (count: number) => poll.closed && count > 0 && count === maxCount;

  function toggle(id: string) {
    if (poll.closed) return;
    const chosen = poll.mine.includes(id);
    const next = poll.multi ? (chosen ? poll.mine.filter((x) => x !== id) : [...poll.mine, id]) : chosen ? [] : [id];
    vote.mutate(next);
  }

  const kind = poll.multi ? 'Chọn nhiều' : 'Chọn một';
  const people = poll.totalVoters > 0 ? `${poll.totalVoters} người đã bình chọn` : 'Chưa có ai bình chọn';
  const groupLabel = `Bình chọn: ${story.body.slice(0, 80)}`;

  return (
    <div className={`poll${poll.closed ? ' is-closed' : ''}`}>
      <div
        className="poll__options"
        role={poll.multi ? 'group' : 'radiogroup'}
        aria-label={groupLabel}
        aria-disabled={poll.closed || undefined}
      >
        {poll.options.map((o) => {
          const mine = poll.mine.includes(o.id);
          const p = pct(o.count, poll.totalVoters);
          const top = isTop(o.count);
          return (
            <div key={o.id} className={`poll-opt${mine ? ' is-mine' : ''}${top ? ' is-top' : ''}`}>
              <button
                type="button"
                role={poll.multi ? 'checkbox' : 'radio'}
                aria-checked={mine}
                aria-disabled={poll.closed || undefined}
                aria-label={`${o.text}: ${p}%, ${o.count} phiếu${top ? ', nhiều phiếu nhất' : ''}`}
                className="poll-opt__btn"
                onClick={() => toggle(o.id)}
              >
                <span className="poll-opt__bar" style={{ width: `${p}%` }} aria-hidden="true" />
                <span className={`poll-opt__mark poll-opt__mark--${poll.multi ? 'box' : 'dot'}`} aria-hidden="true">
                  {mine && <Icon name="check" size={14} strokeWidth={3} />}
                </span>
                <span className="poll-opt__text">{o.text}</span>
                {top && <span className="poll-opt__top">Nhiều nhất</span>}
                <span className="poll-opt__pct" aria-hidden="true">
                  {p}%
                </span>
              </button>
              {o.count > 0 && (
                <button
                  type="button"
                  className="poll-opt__voters"
                  aria-label={`Xem ${o.count} người chọn “${o.text}”`}
                  onClick={() => setVoters({ id: o.id, text: o.text })}
                >
                  <span className="poll-opt__faces" aria-hidden="true">
                    {o.voterPreview.map((u) => (
                      <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size={22} />
                    ))}
                  </span>
                  <span>{o.count} phiếu</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="poll__meta">
        <span>{kind}</span>
        <span aria-hidden="true"> · </span>
        <span>{people}</span>
        <span aria-hidden="true"> · </span>
        {poll.closed ? (
          <strong className="poll__closed">Đã kết thúc</strong>
        ) : poll.endsAt ? (
          <span title={`Kết thúc lúc ${formatDateTime(poll.endsAt)}`}>{timeLeft(poll.endsAt)}</span>
        ) : (
          <span>Không giới hạn thời gian</span>
        )}
      </p>
      <VotersSheet storyId={story.id} option={voters} onClose={() => setVoters(null)} />
    </div>
  );
}

function VotersSheet({ storyId, option, onClose }: { storyId: string; option: { id: string; text: string } | null; onClose: () => void }) {
  const list = useQuery({
    queryKey: pollVotersKey(storyId, option?.id ?? ''),
    queryFn: () => friendStoriesApi.pollVoters(storyId, option!.id),
    enabled: option !== null,
    staleTime: 15_000,
  });
  return (
    <BottomSheet open={option !== null} onClose={onClose} title={option ? `Đã chọn “${option.text}”` : ''}>
      {list.isLoading && <Skeleton height={52} count={3} />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && <p className="text-muted">Chưa có ai để hiện ở đây.</p>}
      {list.isSuccess && list.data.items.length > 0 && (
        <div className="list">
          {list.data.items.map((u) => (
            <Link key={u.id} to={`/friends/u/${u.id}`} className="list__item" onClick={onClose}>
              <Avatar name={u.displayName} src={u.avatarUrl} size={40} />
              <span className="list__body">
                <span className="list__label">{u.displayName}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}
