import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import type { CouplePulse, Mood, MoodHistory, MoodView, NudgeKind, NudgeSent } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';

export const nudgesApi = {
  send: (kind: NudgeKind) => apiRequest<NudgeSent>('/nudges', { method: 'POST', body: { kind } }),
};

export const moodsApi = {
  setToday: (mood: Mood, note: string) => apiRequest<MoodView>('/moods/today', { method: 'PUT', body: { mood, note } }),
  history: (days: number) => apiRequest<MoodHistory>(`/moods?days=${days}`),
};

export const MOODS_KEY = ['moods'] as const;
export const moodHistoryKey = (days: number) => ['moods', 'history', days] as const;

export const MAX_MOOD_NOTE = 140;
/** Server-side wait between two nudges (POST /api/nudges answers 429 NUDGE_TOO_SOON before that). */
export const NUDGE_COOLDOWN_SEC = 30;

/** After saving my mood: show it at once on Home, then refresh the history. */
export async function applyMyMood(qc: QueryClient, mood: MoodView): Promise<void> {
  qc.setQueryData<CouplePulse>(PULSE_KEY, (old) => (old ? { ...old, moods: { mine: mood, partner: old.moods?.partner ?? null } } : old));
  await qc.invalidateQueries({ queryKey: MOODS_KEY });
}
