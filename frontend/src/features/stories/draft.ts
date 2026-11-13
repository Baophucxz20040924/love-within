import type { Mood } from '../../lib/types';

/** Unsent post text kept on this device (photos are not kept: they upload only when posting). */
export interface StoryDraft {
  body: string;
  mood: Mood | null;
  happenedOn: string | null;
}

const keyFor = (userId: string) => `lw.storyDraft.${userId}`;

export function loadDraft(userId: string): StoryDraft | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<StoryDraft>;
    if (typeof d.body !== 'string') return null;
    return { body: d.body, mood: d.mood ?? null, happenedOn: d.happenedOn ?? null };
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, d: StoryDraft): void {
  try {
    if (!d.body.trim() && !d.mood && !d.happenedOn) localStorage.removeItem(keyFor(userId));
    else localStorage.setItem(keyFor(userId), JSON.stringify(d));
  } catch {
    // Storage full or disabled: drafts are best-effort.
  }
}

export function clearDraft(userId: string): void {
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    // ignore
  }
}
