import type { QueryClient } from '@tanstack/react-query';
import { apiRequest, ApiRequestError, waitForAbort, withRequestDeadline } from '../../lib/apiClient';
import { compressImageWithSize } from '../../lib/image';
import type { MomentDay, MomentMonth, MomentSession, MomentStoryResult, MomentTarget, UploadUrlResult } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';
import { LEDGER_KEY, QUESTS_KEY, WALLET_KEY } from '../quests/api';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const enc = encodeURIComponent;

export const MAX_MOMENT_CAPTION = 100;
export const MOMENT_UPLOAD_TIMEOUT_MS = 60_000;
export const MOMENT_POST_TIMEOUT_MS = 20_000;
export const MOMENT_CHECK_TIMEOUT_MS = 15_000;
export interface MomentRewardSummary {
  policyVersion: 1 | 2; effectiveDate: string; localDate: string;
  status: 'legacy' | 'waiting' | 'pending' | 'awarded';
  baseCoin: number; bonusCoin: number; coinAwarded: number; commonStreak: number | null;
}
export interface MomentPostReceipt extends MomentTarget { saved: true; postedAt: string }
export type MomentPostResult = MomentPostReceipt | MomentDay;
export function isConfirmedMoment(result: MomentPostResult, target: MomentTarget): boolean {
  if (result.localDate !== target.localDate) return false;
  return 'saved' in result
    ? result.saved === true && result.sessionId === target.sessionId && Number.isFinite(Date.parse(result.postedAt))
    : result.sessions.some((session) => session.localDate === target.localDate && session.sessionId === target.sessionId && !!session.mine);
}

/** Definitive validation failures can retry; all ambiguous writes must be checked, never blindly reposted. */
export function isUncertainMomentPost(err: unknown): boolean {
  return !(err instanceof ApiRequestError) || err.status >= 500 || [408, 409].includes(err.status)
    || ['REQUEST_TIMEOUT', 'ACCESS_CHANGED', 'SESSION_CHANGED'].includes(err.code);
}

export const momentsApi = {
  today: () => apiRequest<MomentDay>('/moments/today'),
  month: (month: string) => apiRequest<MomentMonth>(`/moments?month=${enc(month)}`),
  /** 409 MOMENT_NOT_YET before the prompt, MOMENT_ALREADY_POSTED after my post. */
  uploadUrl: (target: MomentTarget, mimeType: string, sizeBytes: number, signal?: AbortSignal) =>
    apiRequest<UploadUrlResult>('/moments/upload-url', { method: 'POST', body: { ...target, mimeType, sizeBytes }, signal, timeoutMs: MOMENT_UPLOAD_TIMEOUT_MS }),
  post: (input: MomentTarget & { key: string; width: number; height: number; caption: string }, signal?: AbortSignal) =>
    apiRequest<MomentPostResult>('/moments/today', { method: 'POST', body: input, signal, timeoutMs: MOMENT_POST_TIMEOUT_MS }),
  /** History preserves the original date across midnight; `mine` is scoped by authenticated couple/member. */
  reconcile: async (target: MomentTarget, signal?: AbortSignal): Promise<MomentDay | null> => {
    const month = await apiRequest<MomentMonth>(`/moments?month=${enc(target.localDate.slice(0, 7))}`, { signal, timeoutMs: MOMENT_CHECK_TIMEOUT_MS });
    const day = month.days.find((entry) => entry.localDate === target.localDate);
    return day && isConfirmedMoment(day, target) ? day : null;
  },
  toStory: (target: MomentTarget) => apiRequest<MomentStoryResult>(`/moments/${enc(target.localDate)}/story`, { method: 'POST', body: { sessionId: target.sessionId } }),
};

/** Best-effort story-photo compression → presigned URL → PUT. The legacy decode fallback may retain the original file and metadata. */
export function uploadMomentPhoto(file: File, target: MomentTarget, assertCurrent: () => void, signal?: AbortSignal): Promise<{ key: string; width: number; height: number }> {
  return withRequestDeadline(MOMENT_UPLOAD_TIMEOUT_MS, signal, async (uploadSignal) => {
    const check = () => {
      if (uploadSignal?.aborted) throw uploadSignal.reason;
      assertCurrent();
    };
    check();
    const { blob, width, height } = await waitForAbort(compressImageWithSize(file, 1600, 0.85), uploadSignal);
    check();
    const mimeType = blob.type || 'image/jpeg';
    if (!ALLOWED.includes(mimeType)) throw new Error('Định dạng ảnh này chưa được hỗ trợ. Hãy chụp lại hoặc chọn ảnh JPEG/PNG.');
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB).');
    const { uploadUrl, imageKey } = await momentsApi.uploadUrl(target, mimeType, blob.size, uploadSignal);
    check();
    const put = await waitForAbort(fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob, signal: uploadSignal }), uploadSignal);
    check();
    if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
    // Unknown size (browser could not decode) → assume 3:4 portrait for layout.
    return { key: imageKey, width: width || 1200, height: height || 1600 };
  });
}

export const MOMENTS_KEY = ['moments'] as const;
export const MOMENT_TODAY_KEY = ['moments', 'today'] as const;
export const momentMonthKey = (month: string) => ['moments', 'month', month] as const;

export const momentReceiptKey = (target: MomentTarget) => ['moments', 'receipt', target.localDate, target.sessionId] as const;

/** A receipt proves persistence, not a signed photo or a reward. Never invent either in the cache. */
export function cacheConfirmedMoment(qc: QueryClient, target: MomentTarget, result: MomentPostResult): void {
  if (!isConfirmedMoment(result, target)) return;
  if ('saved' in result) {
    qc.setQueryData(momentReceiptKey(target), result);
    return;
  }
  const session = result.sessions.find((entry) => entry.sessionId === target.sessionId)!;
  qc.setQueryData(momentReceiptKey(target), { ...target, saved: true, postedAt: session.mine!.postedAt });
  const merge = (day: MomentDay): MomentDay => {
    if (day.localDate !== target.localDate) return day;
    const old = day.sessions.find((entry) => entry.sessionId === target.sessionId);
    const confirmed = old?.partner.posted && !session.partner.posted
      ? { ...session, partner: old.partner, state: old.state, storyId: old.storyId ?? session.storyId } : session;
    return { ...day, ...result, sessions: old ? day.sessions.map((entry) => entry.sessionId === target.sessionId ? confirmed : entry) : [...day.sessions, confirmed] };
  };
  qc.setQueryData<MomentDay>(MOMENT_TODAY_KEY, (old) => old ? merge(old) : undefined);
  qc.setQueryData<MomentMonth>(momentMonthKey(target.localDate.slice(0, 7)), (old) => old ? {
    ...old, days: old.days.some((day) => day.localDate === target.localDate)
      ? old.days.map(merge) : [...old.days, result].sort((a, b) => a.localDate.localeCompare(b.localDate)),
  } : undefined);
}

/** Best-effort background refresh. Failure/hanging refetch never controls mutation completion. */
export async function refreshMoments(qc: QueryClient, target?: MomentTarget): Promise<void> {
  const keys = target ? [momentMonthKey(target.localDate.slice(0, 7)), MOMENT_TODAY_KEY, PULSE_KEY, QUESTS_KEY, WALLET_KEY, LEDGER_KEY]
    : [MOMENTS_KEY, PULSE_KEY, QUESTS_KEY, WALLET_KEY, LEDGER_KEY];
  await Promise.allSettled(keys.map((queryKey) => Promise.resolve().then(() => qc.invalidateQueries({ queryKey }))));
}

/** "Muộn 25 phút", "Muộn 2 giờ" (whole hours); null when on time. */
export function lateText(lateMin: number): string | null {
  if (lateMin <= 0) return null;
  return lateMin < 60 ? `Muộn ${lateMin} phút` : `Muộn ${Math.floor(lateMin / 60)} giờ`;
}

/** Reward eligibility uses timestamps, never the rounded display-only lateMin. */
export function isMomentPhotoOnTime(session: Pick<MomentSession, 'promptAt' | 'rewardEndsAt'>, postedAt: string): boolean {
  const posted = Date.parse(postedAt);
  return posted >= Date.parse(session.promptAt) && posted < Date.parse(session.rewardEndsAt);
}

/** "07:42" left in the 30-minute reward window. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
