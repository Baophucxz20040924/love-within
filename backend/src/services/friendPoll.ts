import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import {
  MAX_POLL_OPTION,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type FriendPoll,
  type FriendStoryDoc,
  type PollDurationDays,
  type PollOption,
} from '../models/FriendStory.js';
import type { NewPoll } from '../repositories/friendStory.repository.js';
import { AppError } from '../utils/errors.js';
import { profileOf, type PublicProfile } from './profile.service.js';

// Polls in friends posts (BB6, plan/ENGINEERING_WORKFLOW.md). Input checks, edit rules and the view; the requests themselves
// (vote, unvote, voters) are in friendStory.service.ts, behind the same visibility check as reactions.

const DAY_MS = 86_400_000;
/** Voter photos shown per option. */
export const VOTER_PREVIEW = 3;
/** Voters listed per option (GET …/poll/voters). */
export const VOTERS_LIMIT = 500;

/** Create and edit. `durationDays` left out on edit = keep the current deadline. */
export interface FriendPollInput {
  options: string[];
  multi: boolean;
  durationDays?: PollDurationDays;
}

export interface FriendPollOptionView {
  id: string;
  text: string;
  /** Everyone who chose it (people blocked either way included: results stay true; only their faces are left out). */
  count: number;
  /** Up to 3, newest voter first, without people blocked either way with the viewer. */
  voterPreview: PublicProfile[];
}

export interface FriendPollView {
  options: FriendPollOptionView[];
  /** People who voted (for a multiple-choice poll an option's % is count / totalVoters, so the sum can pass 100 %). */
  totalVoters: number;
  /** My option ids (empty: not voted). */
  mine: string[];
  multi: boolean;
  endsAt: string | null;
  /** The deadline has passed: no more votes or changes. */
  closed: boolean;
}

export const pollErrors = {
  notFound: () => new AppError(404, 'POLL_NOT_FOUND', 'Bài viết này không có bình chọn'),
  closed: () => new AppError(409, 'POLL_CLOSED', 'Bình chọn đã kết thúc'),
  badOption: () => new AppError(400, 'BAD_OPTION', 'Lựa chọn không hợp lệ. Tải lại bài viết nhé.'),
  single: () => new AppError(400, 'SINGLE_CHOICE', 'Bình chọn này chỉ được chọn một lựa chọn'),
  locked: () => new AppError(409, 'POLL_LOCKED', 'Đã có người bình chọn nên không sửa hay gỡ được bình chọn nữa'),
  noQuestion: () => new AppError(400, 'POLL_NEEDS_QUESTION', 'Hãy viết câu hỏi cho bình chọn'),
  duplicate: () => new AppError(400, 'POLL_DUPLICATE_OPTIONS', 'Các lựa chọn phải khác nhau'),
};

const newOptionId = () => randomBytes(4).toString('hex');
const sameText = (a: string, b: string) => a.toLocaleLowerCase('vi') === b.toLocaleLowerCase('vi');

export function isPollClosed(poll: Pick<FriendPoll, 'endsAt'>, now = new Date()): boolean {
  return poll.endsAt !== null && poll.endsAt.getTime() <= now.getTime();
}

export function voteCount(poll: FriendPoll): number {
  return poll.votes?.size ?? 0;
}

/** Trimmed texts, 2–4, ≤ 80 characters, no two alike (ignoring case). zod checks the same at the route. */
function cleanOptions(raw: string[]): string[] {
  const texts = raw.map((t) => t.replace(/\s+/g, ' ').trim());
  if (texts.length < POLL_MIN_OPTIONS || texts.length > POLL_MAX_OPTIONS || texts.some((t) => !t || t.length > MAX_POLL_OPTION)) {
    throw new AppError(400, 'VALIDATION_ERROR', `Bình chọn cần ${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} lựa chọn, mỗi lựa chọn tối đa ${MAX_POLL_OPTION} ký tự`);
  }
  texts.forEach((t, i) => {
    if (texts.some((u, j) => j < i && sameText(t, u))) throw pollErrors.duplicate();
  });
  return texts;
}

/** A new post's poll (no deadline when `durationDays` is left out). */
export function newPoll(input: FriendPollInput, now = new Date()): NewPoll {
  const days = input.durationDays ?? 0;
  return {
    options: cleanOptions(input.options).map((text) => ({ id: newOptionId(), text })),
    multi: input.multi,
    endsAt: days > 0 ? new Date(now.getTime() + days * DAY_MS) : null,
    closedNotifiedAt: null,
  };
}

/**
 * What an edit does to the poll: `undefined` = leave it as it is (votes untouched), a NewPoll = replace it, null = remove
 * it. Same texts in the same order, same "Cho chọn nhiều" and no new deadline count as unchanged. Any change needs a poll
 * without votes (POLL_LOCKED otherwise); the repository checks that again in the update itself. A replaced poll keeps
 * the ids of options whose text did not change, and keeps its "author told" flag only when the deadline stays.
 */
export function pollEdit(current: FriendPoll | null, input: FriendPollInput | null | undefined, now = new Date()): NewPoll | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) {
    if (!current) return undefined;
    if (voteCount(current) > 0) throw pollErrors.locked();
    return null;
  }
  if (!current) return newPoll(input, now);
  const texts = cleanOptions(input.options);
  const unchanged =
    input.durationDays === undefined &&
    input.multi === current.multi &&
    texts.length === current.options.length &&
    texts.every((t, i) => t === current.options[i].text);
  if (unchanged) return undefined;
  if (voteCount(current) > 0) throw pollErrors.locked();
  const options: PollOption[] = texts.map((text) => ({ id: current.options.find((o) => o.text === text)?.id ?? newOptionId(), text }));
  const endsAt =
    input.durationDays === undefined ? current.endsAt : input.durationDays > 0 ? new Date(now.getTime() + input.durationDays * DAY_MS) : null;
  const sameEnd = (endsAt?.getTime() ?? null) === (current.endsAt?.getTime() ?? null);
  return { options, multi: input.multi, endsAt, closedNotifiedAt: sameEnd ? current.closedNotifiedAt : null };
}

/**
 * The chosen ids, checked before writing: the poll exists, is open, every id is one of its options (no duplicates), and a
 * single-choice poll gets exactly one. Closed wins over a bad option (409 before 400).
 */
export function checkVote(story: FriendStoryDoc, optionIds: string[], now = new Date()): string[] {
  const poll = story.poll;
  if (!poll) throw pollErrors.notFound();
  if (isPollClosed(poll, now)) throw pollErrors.closed();
  const ids = [...new Set(optionIds)];
  if (ids.length !== optionIds.length || ids.some((id) => !poll.options.some((o) => o.id === id))) throw pollErrors.badOption();
  if (!poll.multi && ids.length !== 1) throw pollErrors.single();
  // Stored in the order of the options, so the same choice is always the same array.
  return poll.options.filter((o) => ids.includes(o.id)).map((o) => o.id);
}

/** Voters of one option, newest first (votes keep the order people first voted in). */
export function votersOf(poll: FriendPoll, optionId: string): string[] {
  const out: string[] = [];
  for (const [userId, ids] of poll.votes ?? new Map<string, string[]>()) if (ids.includes(optionId)) out.push(userId);
  return out.reverse();
}

/** Ids whose photos the views of these posts need (newest voters per option, without blocked people). */
export function previewIdsOf(stories: FriendStoryDoc[], blocked: ReadonlySet<string>): Types.ObjectId[] {
  const ids = new Set<string>();
  for (const s of stories) {
    if (!s.poll) continue;
    for (const o of s.poll.options) {
      for (const id of votersOf(s.poll, o.id).filter((v) => !blocked.has(v)).slice(0, VOTER_PREVIEW)) ids.add(id);
    }
  }
  return [...ids].map((id) => new Types.ObjectId(id));
}

export function pollView(poll: FriendPoll, userId: string, profiles: Map<string, PublicProfile>, blocked: ReadonlySet<string>, now = new Date()): FriendPollView {
  const votes = poll.votes ?? new Map<string, string[]>();
  return {
    options: poll.options.map((o) => {
      const voters = votersOf(poll, o.id);
      return {
        id: o.id,
        text: o.text,
        count: voters.length,
        voterPreview: voters
          .filter((v) => !blocked.has(v))
          .slice(0, VOTER_PREVIEW)
          .map((v) => profileOf(profiles, v)),
      };
    }),
    totalVoters: votes.size,
    mine: [...(votes.get(userId) ?? [])],
    multi: poll.multi,
    endsAt: poll.endsAt ? poll.endsAt.toISOString() : null,
    closed: isPollClosed(poll, now),
  };
}
