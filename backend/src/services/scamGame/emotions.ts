/** Fictional roleplay states, independent of trust and terminal decisions. */
export const SCAM_EMOTIONS = ['neutral', 'happy', 'excited', 'amused', 'confident', 'grateful', 'curious', 'thoughtful', 'confused', 'embarrassed', 'worried', 'skeptical', 'annoyed', 'angry', 'disappointed', 'sad'] as const;
export type ScamEmotion = typeof SCAM_EMOTIONS[number];
export const isScamEmotion = (value: unknown): value is ScamEmotion => typeof value === 'string' && (SCAM_EMOTIONS as readonly string[]).includes(value);
export const emotionFor = (match: { emotion?: unknown }): ScamEmotion => isScamEmotion(match.emotion) ? match.emotion : 'neutral';
