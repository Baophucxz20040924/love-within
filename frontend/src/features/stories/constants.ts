import type { Mood, ReactionType } from '../../lib/types';

/** Facebook's reaction set (Vietnamese labels as on FB). Colors meet AA on white. */
export const REACTIONS: { type: ReactionType; emoji: string; label: string; color: string }[] = [
  { type: 'like', emoji: '👍', label: 'Thích', color: '#0b5bd3' },
  { type: 'love', emoji: '❤️', label: 'Yêu thích', color: '#e11d48' },
  { type: 'care', emoji: '🥰', label: 'Thương thương', color: '#b45309' },
  { type: 'haha', emoji: '😆', label: 'Haha', color: '#b45309' },
  { type: 'wow', emoji: '😮', label: 'Wow', color: '#b45309' },
  { type: 'sad', emoji: '😢', label: 'Buồn', color: '#b45309' },
];

export function reactionOf(type: ReactionType) {
  return REACTIONS.find((r) => r.type === type) ?? REACTIONS[0];
}

/** "… đang cảm thấy 🥰 được yêu" */
export const MOODS: { key: Mood; emoji: string; label: string }[] = [
  { key: 'happy', emoji: '😊', label: 'hạnh phúc' },
  { key: 'loved', emoji: '🥰', label: 'được yêu' },
  { key: 'in_love', emoji: '😍', label: 'đang yêu' },
  { key: 'grateful', emoji: '🙏', label: 'biết ơn' },
  { key: 'excited', emoji: '🤩', label: 'hào hứng' },
  { key: 'peaceful', emoji: '😌', label: 'bình yên' },
  { key: 'missing', emoji: '🥺', label: 'nhớ nhau' },
  { key: 'tired', emoji: '😴', label: 'mệt mỏi' },
  { key: 'sad', emoji: '😢', label: 'buồn' },
];

export function moodOf(key: Mood | null) {
  return key ? (MOODS.find((m) => m.key === key) ?? null) : null;
}
