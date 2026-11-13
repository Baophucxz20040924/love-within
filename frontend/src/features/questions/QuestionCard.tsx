import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/StatusViews';
import type { CouplePulse } from '../../lib/types';
import { useAvatarOf } from '../auth/useAvatarOf';
import { QUESTION_TODAY_KEY, questionsApi, stateOf } from './api';
import { AnswerSheet, AskSheet } from './QuestionSheets';
import { questionLabel, useCouplePeople } from './useCouplePeople';

interface Props {
  /** Today's question as seen by the Home pulse (polled); null/undefined until it loads or if it failed. */
  pulse: CouplePulse['question'] | undefined;
  pulseUpdatedAt: number;
}

/**
 * Home card "Câu hỏi hôm nay" (CP1), always shown. Four states: nobody answered · partner answered (hidden) ·
 * I answered (waiting) · both answered. The text comes from GET /questions/today, loaded once and again only when
 * the polled pulse reports a different question or state.
 */
export function QuestionCard({ pulse, pulseUpdatedAt }: Props) {
  const navigate = useNavigate();
  const avatarOf = useAvatarOf();
  const { myId, partnerId, partnerName, partnerFullName } = useCouplePeople();
  const [answerOpen, setAnswerOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  const today = useQuery({ queryKey: QUESTION_TODAY_KEY, queryFn: questionsApi.today, staleTime: 60_000 });
  const q = today.data;
  const state = q ? stateOf(q) : null;
  const { refetch, isFetching, dataUpdatedAt } = today;

  useEffect(() => {
    if (!pulse || !q || isFetching || pulseUpdatedAt <= dataUpdatedAt) return;
    if (pulse.id !== q.id || pulse.state !== state) void refetch();
  }, [pulse, q, state, isFetching, pulseUpdatedAt, dataUpdatedAt, refetch]);

  if (today.isLoading) return <Skeleton height={190} />;
  if (!q) {
    return (
      <section className="card q-card" aria-label="Câu hỏi hôm nay">
        <div className="row">
          <span className="icon-tile icon-tile--warning" aria-hidden="true">
            <Icon name="alert" />
          </span>
          <p className="grow text-sm text-muted">Không tải được câu hỏi hôm nay.</p>
          <button type="button" className="btn btn-outline" onClick={() => void refetch()}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }

  const label = questionLabel(q, myId, partnerName);

  return (
    <section className="card q-card" aria-labelledby="q-card-title">
      <div className="row">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="messageCircle" />
        </span>
        <div className="grow">
          <h2 id="q-card-title" className="card__title">
            Câu hỏi hôm nay
          </h2>
          {label && <p className="text-sm text-muted">{label}</p>}
        </div>
        <Link to="/questions" className="btn btn-ghost q-card__history">
          Lịch sử
        </Link>
      </div>

      <p className="q-card__text">{q.text}</p>

      {state === 'partner_answered' && (
        <p className="q-card__status">
          <Avatar name={partnerFullName} src={avatarOf(partnerId)} size={28} />
          <span>
            <strong>{partnerName}</strong> đã trả lời 🔒 Trả lời để xem
          </span>
        </p>
      )}
      {state === 'mine_answered' && (
        <p className="q-card__status">
          <Icon name="clock" size={18} />
          <span>Đang chờ {partnerName} trả lời</span>
        </p>
      )}

      {state === 'both' ? (
        <Link to={`/questions/${q.id}`} className="btn btn-primary btn-block">
          Xem câu trả lời của hai bạn
        </Link>
      ) : state === 'mine_answered' ? (
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setAnswerOpen(true)}>
          <Icon name="edit" size={18} /> Sửa câu trả lời
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-block" onClick={() => setAnswerOpen(true)}>
          Trả lời
        </button>
      )}

      <div className="q-card__foot">
        {q.myAsk ? (
          <p className="text-sm text-muted q-card__asked">
            <Icon name="check" size={16} /> Bạn đã gửi một câu hỏi cho ngày mai
          </p>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setAskOpen(true)}>
            <Icon name="send" size={18} /> Hỏi {partnerName} một câu
          </button>
        )}
      </div>

      <AnswerSheet
        open={answerOpen}
        question={q}
        onClose={() => setAnswerOpen(false)}
        onSaved={(saved) => saved.locked && navigate(`/questions/${saved.id}`)}
      />
      <AskSheet open={askOpen} onClose={() => setAskOpen(false)} />
    </section>
  );
}
