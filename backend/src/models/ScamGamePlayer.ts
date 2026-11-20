import { Schema, model, type Types } from 'mongoose';
import type { ScamCharacter } from '../services/scamGame/characters.js';
import type { ScamEmotion } from '../services/scamGame/emotions.js';

export const SCAM_RULE_VERSION = 1;
export type ScamStage = 'account' | 'password' | 'otp' | 'identityCode' | 'dob' | 'recoveryQuestion1' | 'recoveryQuestion2';
export type ScamStatus = 'active' | 'won' | 'lost' | 'stopped';
export interface ScamBubble { id: string; role: 'user' | 'assistant' | 'system'; text: string; operationId?: string }
export interface ScamMemory { summary: string; facts: string[]; openThreads: string[] }
export interface ScamRuntimeContext {
  version: 1;
  profile: Pick<ScamCharacter, 'id' | 'name' | 'persona'>;
  scene: string;
  memory: ScamMemory;
}
export interface ScamMatch {
  id: string;
  character: Pick<ScamCharacter, 'id' | 'name' | 'emoji' | 'description'> & Partial<Pick<ScamCharacter, 'persona' | 'opening'>>;
  status: ScamStatus;
  stage: ScamStage;
  score: number;
  bonus?: number; // Legacy terminal matches have no bonus.
  trust: number;
  emotion?: ScamEmotion; // Older matches have no emotion until an accepted AI turn.
  turns: number;
  scenario?: import('../services/scamGame/scenarios.js').ScenarioSelection;
  secrets: Record<string, string>;
  revealed: ScamStage[];
  messages: ScamBubble[];
  memory?: string; // Legacy active matches are upgraded on their next mutation.
  runtimeContext?: ScamRuntimeContext;
  startedAt: string;
  endedAt: string | null;
}
export interface ScamPending {
  operationId: string;
  fingerprint: string;
  token: string;
  expectedRevision: number;
  expiresAt: number;
  text: string;
}
export interface ScamReceipt { operationId: string; fingerprint: string }
export interface ScamPlayer {
  _id: Types.ObjectId;
  revision: number;
  ruleVersion: number;
  bestScore: number;
  wins: number;
  completed: number;
  match: ScamMatch | null;
  pending: ScamPending | null;
  receipts: ScamReceipt[];
}

// Bounded state is replaced only through the repository revision fence. No wallet association.
const schema = new Schema<ScamPlayer>({
  _id: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, required: true },
  ruleVersion: { type: Number, required: true },
  bestScore: { type: Number, required: true },
  wins: { type: Number, required: true },
  completed: { type: Number, required: true },
  match: { type: Schema.Types.Mixed, default: null },
  pending: { type: Schema.Types.Mixed, default: null },
  receipts: { type: [new Schema<ScamReceipt>({ operationId: { type: String, required: true }, fingerprint: { type: String, required: true } }, { _id: false })], default: [] },
}, { versionKey: false });
schema.index({ ruleVersion: 1, bestScore: -1, wins: -1, _id: 1 });
export const ScamGamePlayer = model<ScamPlayer>('ScamGamePlayer', schema);
