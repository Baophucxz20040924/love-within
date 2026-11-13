import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { QUESTION_TODAY_KEY, questionKey, questionsApi } from '../features/questions/api';
import { AnswerPair } from '../features/questions/AnswerPair';
import { AnswerSheet } from '../features/questions/QuestionSheets';
import { questionLabel, useCouplePeople } from '../features/questions/useCouplePeople';
import { ApiRequestError } from '../lib/apiClient';
import { dayHeading } from '../lib/format';

/** /questions/:id (or /questions/today) — one day's question with both answers. */
export function QuestionDetailPage() {
  const { id = '' } = useParams();
  const isToday = id === 'today';
  const { myId, partnerName, today } = useCouplePeople();
  const [answerOpen, setAnswerOpen] = useState(false);

  const query = useQuery({
    queryKey: isToday ? QUESTION_TODAY_KEY : questionKey(id),
    queryFn: () => (isToday ? questionsApi.today() : questionsApi.get(id)),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: (count, err) => !(err instanceof ApiRequestError && (err.status === 404 || err.status === 400)) && count < 1,
  });
  const q = query.data;
  const notFound = query.error instanceof ApiRequestError && (query.error.status === 404 || query.error.status === 400);
  const label = q ? questionLabel(q, myId, partnerName) : null;

  return (
    <Page title="Câu hỏi" subtitle={q ? dayHeading(q.localDate, today) : undefined} back="/questions">
      {query.isLoading && <Skeleton height={260} />}
      {query.isError &&
        (notFound ? (
          <ErrorState title="Không tìm thấy câu hỏi" message="Câu hỏi này không tồn tại." />
        ) : (
          <ErrorState onRetry={() => void query.refetch()} />
        ))}
      {q && !query.isError && (
        <>
          <section className="card q-detail">
            {label && <span className="chip chip--brand">{label}</span>}
            <p className="q-detail__text">{q.text}</p>
          </section>

          <AnswerPair q={q} />

          {!q.mine && (
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => setAnswerOpen(true)}>
              {q.localDate < today ? 'Trả lời bù' : 'Trả lời'}
            </button>
          )}
          {q.mine && !q.locked && (
            <>
              <button type="button" className="btn btn-secondary btn-block" onClick={() => setAnswerOpen(true)}>
                <Icon name="edit" size={18} /> Sửa câu trả lời
              </button>
              <p className="field__hint center">Bạn sửa được tới khi {partnerName} trả lời.</p>
            </>
          )}
          {q.locked && <p className="field__hint center">Hai bạn đã cùng trả lời nên câu trả lời không sửa được nữa.</p>}

          <AnswerSheet open={answerOpen} question={q} onClose={() => setAnswerOpen(false)} />
        </>
      )}
    </Page>
  );
}
