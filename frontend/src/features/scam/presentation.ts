import type { ScamStage, ScamState } from './types';
import { scenarioOf } from './scenarios';

type Match = NonNullable<ScamState['match']>;
export const baseMoney = (match: Match) => match.score - (match.bonus ?? 0);

export function bubbleText(message: Match['messages'][number]): string {
  if (message.role !== 'system') return message.text;
  if (message.text === 'Bạn đã dừng scam. Điểm đã đạt được giữ lại.') return 'Bạn đã dừng scam. Tiền giả lập đã đạt được giữ lại.';
  return message.text.replace(/^(Đã xác nhận [^\n]+\. \+\d+) điểm\.$/, '$1$.');
}

export interface GameReward { key: string; kind: 'stage' | 'won' | 'lost'; amount: number; bonus: number }
export function stageReward(before: Match, after: Match | null | undefined, stage: ScamStage): GameReward | null {
  if (!after || before.id !== after.id || before.status !== 'active' || before.stage !== stage) return null;
  const steps = scenarioOf(before).steps, index = steps.findIndex(step => step.id === stage);
  if (index < 0 || baseMoney(after) - baseMoney(before) !== steps[index].points) return null;
  const final = index === steps.length - 1;
  if (final ? after.status !== 'won' : after.status !== 'active' || after.stage !== steps[index + 1].id) return null;
  return { key: `${before.id}:${stage}`, kind: final ? 'won' : 'stage', amount: steps[index].points, bonus: after.bonus ?? 0 };
}
