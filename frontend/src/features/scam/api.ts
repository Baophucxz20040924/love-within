import { apiRequest } from '../../lib/apiClient';
import type { ScamBoard, ScamOperation, ScamStage, ScamState } from './types';
const base = '/friends/scam';
export const scamKey = (userId: string) => ['friends', 'scam', userId] as const;
const post = (path: string, body: unknown) => apiRequest<ScamState>(`${base}/${path}`, { method: 'POST', body, timeoutMs: 90_000 });
export const scamApi = {
  state: (signal?: AbortSignal) => apiRequest<ScamState>(`${base}/state`, { signal, timeoutMs: 15_000 }),
  start: (op: ScamOperation) => post('start', { ...op, consent: true }),
  message: (op: ScamOperation, text: string) => post('message', { ...op, text }),
  verify: (op: ScamOperation, stage: ScamStage, value: string) => post('verify', { ...op, stage, value }),
  stop: (op: ScamOperation) => post('stop', op),
  board: (cursor?: string, signal?: AbortSignal) => apiRequest<ScamBoard>(`${base}/leaderboard?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, timeoutMs: 15_000 }),
};
