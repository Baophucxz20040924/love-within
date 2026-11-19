export const emotionLabels = {
  neutral: ['😌', 'Bình thản'],
  happy: ['🙂', 'Vui vẻ'],
  excited: ['🤩', 'Hào hứng'],
  amused: ['😄', 'Thích thú'],
  confident: ['😎', 'Tự tin'],
  grateful: ['🥹', 'Cảm kích'],
  curious: ['🧐', 'Tò mò'],
  thoughtful: ['🤔', 'Trầm tư'],
  confused: ['😕', 'Bối rối'],
  embarrassed: ['😳', 'Ngượng ngùng'],
  worried: ['😟', 'Lo lắng'],
  skeptical: ['🤨', 'Hoài nghi'],
  annoyed: ['😒', 'Khó chịu'],
  angry: ['😠', 'Tức giận'],
  disappointed: ['😞', 'Thất vọng'],
  sad: ['😢', 'Buồn'],
} as const;
export type ScamEmotion = keyof typeof emotionLabels;
export const emotionLabel = (value: unknown) => typeof value === 'string' && Object.hasOwn(emotionLabels, value)
  ? emotionLabels[value as ScamEmotion] : emotionLabels.neutral;
