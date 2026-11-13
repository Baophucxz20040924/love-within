import type { QuestionReaction } from '../../lib/types';

/** Reactions to the partner's answer (keys match the backend's QUESTION_REACTIONS). */
export const QUESTION_REACTIONS: { type: QuestionReaction; emoji: string; label: string }[] = [
  { type: 'heart', emoji: '❤️', label: 'Thương' },
  { type: 'laugh', emoji: '😂', label: 'Buồn cười' },
  { type: 'touched', emoji: '🥹', label: 'Cảm động' },
  { type: 'wow', emoji: '😮', label: 'Bất ngờ' },
  { type: 'like', emoji: '👍', label: 'Thích' },
];

export function reactionEmoji(type: QuestionReaction | null | undefined): string | null {
  return QUESTION_REACTIONS.find((r) => r.type === type)?.emoji ?? null;
}
