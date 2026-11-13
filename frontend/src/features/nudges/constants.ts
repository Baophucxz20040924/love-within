import type { Mood, NudgeKind } from '../../lib/types';

/** The four nudges of the heart button (long-press). "miss" is the one a plain tap sends. */
export const NUDGES: { kind: NudgeKind; emoji: string; label: string }[] = [
  { kind: 'miss', emoji: '💗', label: 'Nhớ' },
  { kind: 'hug', emoji: '🤗', label: 'Ôm' },
  { kind: 'kiss', emoji: '😘', label: 'Hôn' },
  { kind: 'thinking', emoji: '💭', label: 'Đang nghĩ về bạn' },
];

export function nudgeOf(kind: NudgeKind) {
  return NUDGES.find((n) => n.kind === kind) ?? NUDGES[0];
}

/** Hero line about what the partner sent today: "Hà nhớ bạn 3 lần hôm nay", or the kind for the first one. */
export function receivedLine(name: string, count: number, kind: NudgeKind | null): string {
  if (count > 1) return `${name} nhớ bạn ${count} lần hôm nay`;
  switch (kind) {
    case 'hug':
      return `${name} gửi bạn một cái ôm 🤗`;
    case 'kiss':
      return `${name} gửi bạn một nụ hôn 😘`;
    case 'thinking':
      return `${name} đang nghĩ về bạn 💭`;
    default:
      return `${name} đang nhớ bạn 💗`;
  }
}

/**
 * Day cells of "Cảm xúc 30 ngày" (pastel backgrounds behind the mood emoji, which carries the meaning; colour is a
 * second cue only). Dark text on all of them.
 */
export const MOOD_COLORS: Record<Mood, string> = {
  happy: '#fde68a',
  loved: '#fbcfe8',
  in_love: '#fda4af',
  grateful: '#bbf7d0',
  excited: '#fed7aa',
  peaceful: '#bae6fd',
  missing: '#ddd6fe',
  tired: '#cbd5e1',
  sad: '#a5b4fc',
};
