import type { FriendUser, MentionSpan } from '../../lib/types';

/**
 * "@Tên" in comments (plan/ENGINEERING_WORKFLOW.md, BB8). The body is plain text; each mention is a span of it that starts with
 * "@" followed by the person's name. The server checks the spans again (inside the trimmed body, "@" + name, no overlap,
 * at most 10, the person can see the post). Offsets are JavaScript string indexes on both sides.
 */

export const MAX_MENTIONS = 10;

/** A mention while typing: where "@Tên" sits in the box and who it is. */
export interface DraftMention {
  userId: string;
  name: string;
  start: number;
  length: number;
}

const byStart = (a: DraftMention, b: DraftMention) => a.start - b.start;

/**
 * Keep mentions in step with an edit of the box: mentions before the changed part stay, mentions after it move, and a
 * mention whose text was touched becomes plain text (like Facebook).
 */
export function reconcile(prev: string, next: string, mentions: DraftMention[]): DraftMention[] {
  if (prev === next || mentions.length === 0) return mentions;
  const max = Math.min(prev.length, next.length);
  let head = 0;
  while (head < max && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < max - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const changedEnd = prev.length - tail;
  const delta = next.length - prev.length;
  return mentions
    .flatMap((m) => {
      if (m.start + m.length <= head) return [m];
      if (m.start >= changedEnd) return [{ ...m, start: m.start + delta }];
      return [];
    })
    .filter((m) => next.slice(m.start, m.start + m.length) === `@${m.name}`);
}

/** The "@…" being typed just before the caret (start of "@" and the text after it), or null. */
export function activeQuery(text: string, caret: number, mentions: DraftMention[]): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // "a@b" (an email) is not a mention; "@" must start the text or follow a space.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  if (mentions.some((m) => at >= m.start && at < m.start + m.length)) return null;
  const query = before.slice(at + 1);
  // Names have a few words: allow up to 3 spaces, never a new line or a leading space.
  if (query.length > 40 || /[\n@]/.test(query) || /^\s/.test(query) || (query.match(/\s/g) ?? []).length > 3) return null;
  return { start: at, query };
}

/** Put the picked person in place of "@…" (plus one space) and move the mentions after it. */
export function insertMention(
  text: string,
  mentions: DraftMention[],
  active: { start: number; query: string },
  caret: number,
  user: FriendUser,
): { text: string; mentions: DraftMention[]; caret: number } {
  const token = `@${user.displayName}`;
  const after = text.slice(caret);
  const spacer = after.startsWith(' ') ? '' : ' ';
  const next = text.slice(0, active.start) + token + spacer + after;
  const delta = next.length - text.length;
  const moved = mentions.map((m) => (m.start >= caret ? { ...m, start: m.start + delta } : m));
  const added: DraftMention = { userId: user.id, name: user.displayName, start: active.start, length: token.length };
  return { text: next, mentions: [...moved, added].sort(byStart), caret: active.start + token.length + 1 };
}

/** Start a reply with "@Tên " of the person answered (kept when the box already starts with it). */
export function prefillMention(text: string, mentions: DraftMention[], user: FriendUser): { text: string; mentions: DraftMention[] } {
  const token = `@${user.displayName}`;
  if (mentions.some((m) => m.userId === user.id && m.start === 0)) return { text, mentions };
  const prefix = `${token} `;
  return {
    text: prefix + text,
    mentions: [{ userId: user.id, name: user.displayName, start: 0, length: token.length }, ...mentions.map((m) => ({ ...m, start: m.start + prefix.length }))],
  };
}

/** What the API gets: the trimmed body and the spans relative to it (at most 10; extra names stay plain text). */
export function toPayload(text: string, mentions: DraftMention[]): { body: string; mentions: MentionSpan[] } {
  const lead = text.length - text.trimStart().length;
  const body = text.trim();
  const spans = [...mentions]
    .sort(byStart)
    .map((m) => ({ userId: m.userId, offset: m.start - lead, length: m.length }))
    .filter((m) => m.offset >= 0 && m.offset + m.length <= body.length && body[m.offset] === '@')
    .slice(0, MAX_MENTIONS);
  return { body, mentions: spans };
}

export interface Segment {
  text: string;
  /** Set for a mention: the person to open. */
  userId?: string;
}

/** A posted comment split into plain text and mentions (overlapping or out-of-range spans are ignored). */
export function segments(body: string, mentions: MentionSpan[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const m of [...mentions].sort((a, b) => a.offset - b.offset)) {
    if (m.offset < pos || m.offset + m.length > body.length) continue;
    if (m.offset > pos) out.push({ text: body.slice(pos, m.offset) });
    out.push({ text: body.slice(m.offset, m.offset + m.length), userId: m.userId });
    pos = m.offset + m.length;
  }
  if (pos < body.length) out.push({ text: body.slice(pos) });
  return out;
}
