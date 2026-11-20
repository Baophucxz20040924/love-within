import type { ScamEmotion } from './emotions';

export type ScamStage = 'account' | 'password' | 'otp' | 'identityCode' | 'dob' | 'recoveryQuestion1' | 'recoveryQuestion2';
export interface ScamScenario {
  id: 'bank' | 'identity' | 'social'; version: 1; title: string; goal: string; maxScore: number;
  steps: { id: ScamStage; label: string; format: string; inputKind: 'text' | 'password' | 'numeric' | 'date'; points: number }[];
}
export interface ScamOperation { operationId: string; expectedRevision: number; matchId?: string }
export interface ScamState {
  revision: number;
  bestScore: number;
  wins: number;
  mock: boolean;
  recentOperations: string[];
  pending: { operationId: string; expectedRevision: number; expiresAt: number; text: string } | null;
  match: {
    id: string;
    character: { id: string; name: string; emoji: string; description: string };
    status: 'active' | 'won' | 'lost' | 'stopped';
    stage: ScamStage;
    scenario?: ScamScenario;
    score: number;
    trust: number;
    emotion?: ScamEmotion;
    turns: number;
    revealed: ScamStage[];
    messages: { id: string; role: 'user' | 'assistant' | 'system'; text: string; operationId?: string }[];
    startedAt: string;
    endedAt: string | null;
  } | null;
}
export interface ScamBoard {
  items: { player: { id: string; displayName: string; avatarUrl: string | null }; bestScore: number; wins: number; rank: number }[];
  nextCursor: string | null;
}
