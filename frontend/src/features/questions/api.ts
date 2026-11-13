import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import type { DailyQuestion, QuestionPage, QuestionReaction, QuestionState, TodayQuestion } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';
import { QUESTS_KEY } from '../quests/api';

// Question ids come from the page URL (/questions/:id), so encode them before building API paths.
const enc = encodeURIComponent;

export type QuestionFilter = 'all' | 'unanswered';

export const questionsApi = {
  today: () => apiRequest<TodayQuestion>('/questions/today'),
  get: (id: string) => apiRequest<DailyQuestion>(`/questions/${enc(id)}`),
  list: (filter: QuestionFilter, cursor?: string) =>
    apiRequest<QuestionPage>(`/questions?filter=${filter}${cursor ? `&cursor=${enc(cursor)}` : ''}`),
  answer: (id: string, body: string) => apiRequest<DailyQuestion>(`/questions/${enc(id)}/answer`, { method: 'PUT', body: { body } }),
  react: (id: string, type: QuestionReaction) =>
    apiRequest<DailyQuestion>(`/questions/${enc(id)}/reaction`, { method: 'PUT', body: { type } }),
  unreact: (id: string) => apiRequest<DailyQuestion>(`/questions/${enc(id)}/reaction`, { method: 'DELETE' }),
  ask: (text: string) => apiRequest<{ text: string; createdAt: string }>('/questions/ask', { method: 'POST', body: { text } }),
};

export const QUESTIONS_KEY = ['questions'] as const;
export const QUESTION_TODAY_KEY = ['questions', 'today'] as const;
export const questionKey = (id: string) => ['questions', 'detail', id] as const;
export const questionHistoryKey = (filter: QuestionFilter) => ['questions', 'history', filter] as const;

export const MAX_ANSWER = 1000;
export const MAX_ASK = 200;

/** Same states as the pulse, computed from a full question view. */
export function stateOf(q: DailyQuestion): QuestionState {
  if (q.mine && q.partner.answered) return 'both';
  if (q.mine) return 'mine_answered';
  if (q.partner.answered) return 'partner_answered';
  return 'none';
}

/** Put a fresh question view in the caches, then refresh what depends on it (history, Home pulse, quests). */
export async function applyQuestion(qc: QueryClient, q: DailyQuestion): Promise<void> {
  qc.setQueryData(questionKey(q.id), q);
  qc.setQueryData<TodayQuestion>(QUESTION_TODAY_KEY, (old) => (old && old.id === q.id ? { ...q, myAsk: old.myAsk } : old));
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['questions', 'history'] }),
    qc.invalidateQueries({ queryKey: PULSE_KEY }),
    qc.invalidateQueries({ queryKey: QUESTS_KEY }),
  ]);
}
