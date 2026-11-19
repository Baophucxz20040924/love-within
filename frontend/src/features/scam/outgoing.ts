import type { ScamOperation, ScamState } from './types';

export interface OutgoingTurn {
  operation: ScamOperation;
  text: string;
  status: 'sending' | 'pending' | 'uncertain' | 'failed';
  message?: string;
  rejected?: boolean;
}

/** Only call with an accepted, current snapshot. Absence alone never proves a lost POST failed. */
export function reconcileOutgoing(turn: OutgoingTurn | null, state: ScamState): OutgoingTurn | null {
  const match = state.match;
  if (turn && (!match || turn.operation.matchId !== match.id || match.status !== 'active'
    || state.recentOperations.includes(turn.operation.operationId)
    || match.messages.some(m => m.operationId === turn.operation.operationId))) return null;
  const pending = state.pending;
  if (pending && match && (!turn || turn.operation.operationId === pending.operationId)) {
    return { operation: { operationId: pending.operationId, expectedRevision: pending.expectedRevision, matchId: match.id },
      text: pending.text, status: 'pending', message: 'Đang chờ trả lời…' };
  }
  // A rejection + its untouched/released reservation is definitive. Intervening writes
  // may have evicted receipts, so absence at a later revision is not enough.
  if (turn?.rejected && !pending && state.revision >= turn.operation.expectedRevision
    && state.revision <= turn.operation.expectedRevision + 2) return { ...turn, status: 'failed' };
  if (turn?.status === 'pending' && !pending) return { ...turn, status: 'uncertain', message: 'Chưa xác nhận kết quả. Hãy đồng bộ hoặc dừng ván.' };
  return turn;
}
