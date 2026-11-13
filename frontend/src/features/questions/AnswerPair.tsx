import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { DailyQuestion, QuestionReaction } from '../../lib/types';
import { useAvatarOf } from '../auth/useAvatarOf';
import { applyQuestion, questionsApi } from './api';
import { QUESTION_REACTIONS, reactionEmoji } from './constants';
import { useCouplePeople } from './useCouplePeople';

/** Short answers sit side by side; a long one would make two narrow columns hard to read at 360 px, so they stack. */
const SIDE_BY_SIDE_MAX = 160;

/** My answer and my partner's, next to each other, plus my reaction to theirs once both answered. */
export function AnswerPair({ q }: { q: DailyQuestion }) {
  const qc = useQueryClient();
  const toast = useToast();
  const avatarOf = useAvatarOf();
  const { myId, myName, partnerId, partnerFullName, partnerName } = useCouplePeople();

  const react = useMutation({
    mutationFn: (type: QuestionReaction | null) => (type ? questionsApi.react(q.id, type) : questionsApi.unreact(q.id)),
    onSuccess: (view) => applyQuestion(qc, view),
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
  });

  const stack = (q.mine?.body.length ?? 0) > SIDE_BY_SIDE_MAX || (q.partner.body?.length ?? 0) > SIDE_BY_SIDE_MAX;
  const myReactionOnTheirs = q.partner.reaction ?? null;
  const theirReactionOnMine = reactionEmoji(q.mine?.reaction);

  return (
    <>
      <div className={`qa-pair${stack ? ' qa-pair--stack' : ''}`}>
        <article className="qa qa--mine" aria-label="Câu trả lời của bạn">
          <header className="qa__who">
            <Avatar name={myName} src={avatarOf(myId)} size={28} />
            <span className="qa__name">Bạn</span>
            {q.mine?.late && <span className="chip">Trả lời bù</span>}
          </header>
          {q.mine ? <p className="qa__body">{q.mine.body}</p> : <p className="qa__empty">Bạn chưa trả lời</p>}
          {theirReactionOnMine && (
            <p className="qa__reaction">
              <span aria-hidden="true">{theirReactionOnMine}</span> {partnerName} đã thả cảm xúc
            </p>
          )}
        </article>

        <article className="qa qa--partner" aria-label={`Câu trả lời của ${partnerName}`}>
          <header className="qa__who">
            <Avatar name={partnerFullName} src={avatarOf(partnerId)} size={28} />
            <span className="qa__name">{partnerName}</span>
            {q.partner.late && <span className="chip">Trả lời bù</span>}
          </header>
          {q.partner.body !== undefined ? (
            <p className="qa__body">{q.partner.body}</p>
          ) : q.partner.answered ? (
            <p className="qa__locked">
              <Icon name="lock" size={16} /> Đã trả lời. Trả lời để xem nhé
            </p>
          ) : (
            <p className="qa__empty">Chưa trả lời</p>
          )}
        </article>
      </div>

      {q.locked && (
        <div className="card q-react">
          <p className="text-sm text-muted" id={`q-react-${q.id}`}>
            Thả cảm xúc cho câu của {partnerName}
          </p>
          <div className="q-react__opts" role="group" aria-labelledby={`q-react-${q.id}`}>
            {QUESTION_REACTIONS.map((r) => {
              const active = myReactionOnTheirs === r.type;
              return (
                <button
                  key={r.type}
                  type="button"
                  className={`q-react__opt${active ? ' is-active' : ''}`}
                  aria-label={r.label}
                  aria-pressed={active}
                  title={r.label}
                  disabled={react.isPending}
                  onClick={() => react.mutate(active ? null : r.type)}
                >
                  <span aria-hidden="true">{r.emoji}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
