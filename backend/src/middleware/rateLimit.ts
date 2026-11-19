import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { fail } from '../utils/response.js';

/** Key by authenticated user when available, else by IP. */
function keyByUser(req: Request): string {
  return req.userId ?? req.ip ?? 'anonymous';
}

function make(
  windowMs: number,
  limit: number,
  message: string,
  perUser: boolean,
  skipSuccessfulRequests = false,
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator: perUser ? keyByUser : (req) => req.ip ?? 'anonymous',
    handler: (_req, res) => fail(res, 429, 'TOO_MANY_REQUESTS', message),
  });
}

/** Aggregate edge budget: mount on /api before body parsing (health/metrics excluded for monitoring). */
export const edgeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/metrics',
  handler: (_req, res) => fail(res, 429, 'TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu, vui lòng thử lại sau.'),
});

/** Aggregate expensive GET budget. Mount after authentication on selected read routes only. */
export const expensiveReadLimiter = make(60_000, 120, 'Bạn tải dữ liệu quá nhanh, thử lại sau.', true);

/** Aggregate CP7 + proposal decisions / outing mutation budgets, after authentication; never charge GETs.
 * All stores here are per worker and reset on restart; these are not distributed quotas.
 */
export const savingsWriteLimiter = make(60_000, 60, 'Thao tác quá nhanh, thử lại sau.', true);
export const outingsWriteLimiter = make(60_000, 60, 'Thao tác quá nhanh, thử lại sau.', true);

/** Login work budget counts successes too, in addition to the existing failed-attempt guard. */
export const loginTotalLimiter = make(15 * 60_000, 100, 'Quá nhiều lần đăng nhập. Vui lòng đợi 15 phút.', false);

/** Login: 10 FAILED attempts / 15 min per IP. Successful logins don't count (brute-force guard only). */
export const loginLimiter = make(15 * 60_000, 10, 'Sai mật khẩu quá nhiều lần. Vui lòng đợi 15 phút.', false, true);

/** Register: 10 / 15 min per IP. */
export const registerLimiter = make(15 * 60_000, 10, 'Quá nhiều lần đăng ký. Vui lòng đợi 15 phút.', false);

/** Recovery completion is unauthenticated until its purpose-bound grant is checked. */
export const passwordChangeLimiter = make(15 * 60_000, 20, 'Quá nhiều lần đổi mật khẩu. Vui lòng đợi 15 phút.', false);
/** Sensitive admin writes include bcrypt reauthentication; counted on every attempt per admin. */
export const adminCredentialLimiter = make(15 * 60_000, 10, 'Quá nhiều thao tác quản trị. Vui lòng đợi 15 phút.', true);
export const adminLookupLimiter = make(60_000, 30, 'Bạn tìm tài khoản quá nhanh, vui lòng thử lại sau.', true);

/** Token refresh: 60 / 15 min per IP (a tab refreshes about once per 15 min; this only stops token grinding). */
export const refreshLimiter = make(15 * 60_000, 60, 'Quá nhiều yêu cầu, vui lòng thử lại sau.', false);

/** Pairing invites: 20 / day per user (stops invite spam and probing which emails are registered). */
export const inviteLimiter = make(24 * 60 * 60_000, 20, 'Bạn đã gửi quá nhiều lời mời hôm nay.', true);

/** Manual water entries: 30 / hour per user. */
export const waterManualLimiter = make(60 * 60_000, 30, 'Bạn ghi nước quá nhanh, thử lại sau.', true);

/** Water photo analysis: 20 / hour per user (protects AI + S3 cost). */
export const waterPhotoLimiter = make(60 * 60_000, 20, 'Bạn đã gửi quá nhiều ảnh trong giờ này.', true);

/** Upload URL issuance: 30 / hour per user. */
export const uploadUrlLimiter = make(60 * 60_000, 30, 'Quá nhiều yêu cầu tải ảnh.', true);

/** Check-in: 10 / min per user (the unique index is the real guard; this just dampens spam). */
export const checkinLimiter = make(60_000, 10, 'Thao tác quá nhanh, thử lại sau.', true);

const DAY_MS = 24 * 60 * 60_000;

/** Story posts: 30 / day per user. */
export const storyCreateLimiter = make(DAY_MS, 30, 'Bạn đã đăng quá nhiều bài hôm nay.', true);

/** Story photo upload URLs: 100 / day per user (≤ 10 photos per post). */
export const storyUploadLimiter = make(DAY_MS, 100, 'Bạn đã tải quá nhiều ảnh hôm nay.', true);

/** Comments: 120 / hour per user. */
export const commentLimiter = make(60 * 60_000, 120, 'Bạn bình luận quá nhanh, thử lại sau.', true);

/** Daily question answers and edits: 60 / hour per user. */
export const questionAnswerLimiter = make(60 * 60_000, 60, 'Bạn sửa câu trả lời quá nhiều lần, thử lại sau.', true);

/** New countdown events: 30 / day per user. */
export const eventCreateLimiter = make(DAY_MS, 30, 'Bạn đã thêm quá nhiều sự kiện hôm nay.', true);

/** New timed letters: 10 / day per user. */
export const letterCreateLimiter = make(DAY_MS, 10, 'Hôm nay bạn đã gửi 10 lá thư rồi. Mai viết tiếp nhé!', true);

/** Letter photo upload URLs: 50 / day per user (≤ 4 photos per letter, plus retries). */
export const letterUploadLimiter = make(DAY_MS, 50, 'Bạn đã tải quá nhiều ảnh hôm nay.', true);

/** "Cảm xúc hôm nay" changes: 60 / hour per user (one mood per day; this only stops a runaway client). */
export const moodLimiter = make(60 * 60_000, 60, 'Bạn đổi cảm xúc quá nhiều lần, thử lại sau.', true);

/** New bucket list items (CP3): 50 / day per user. */
export const bucketCreateLimiter = make(DAY_MS, 50, 'Hôm nay bạn đã thêm 50 mục rồi. Mai thêm tiếp nhé!', true);

/** Duo moment photo upload URLs (CP6): 20 / day per user (one photo a day, plus retries). */
export const momentUploadLimiter = make(DAY_MS, 20, 'Bạn đã tải quá nhiều ảnh hôm nay.', true);

/** Bank linking: 10 FAILED attempts / hour per user (guards against guessing tokens). */
export const bankConnectLimiter = make(60 * 60_000, 10, 'Bạn thử liên kết quá nhiều lần, vui lòng đợi 1 giờ.', true, true);

/** On-demand bank sync: 10 / min per user (the service also reuses polls younger than 60 s). */
export const bankSyncLimiter = make(60_000, 10, 'Thao tác quá nhanh, thử lại sau.', true);

/** Finance assistant chat: 30 questions / hour per user (protects AI cost). */
export const assistantChatLimiter = make(60 * 60_000, 30, 'Bạn đã hỏi trợ lý quá nhiều trong giờ này, thử lại sau.', true);

/** Short-window abuse controls, not a total-turn or per-game limit. */
export const scamMessageLimiter = make(60_000, 20, 'Bạn gửi quá nhanh, đợi một chút rồi tiếp tục nhé.', true);
export const scamWriteLimiter = make(60_000, 30, 'Bạn thao tác quá nhanh, đợi một chút nhé.', true);

/** Finance assistant insights: 10 / hour per user (cached results also count). */
export const assistantInsightsLimiter = make(60 * 60_000, 10, 'Bạn làm mới phân tích quá nhiều lần, thử lại sau.', true);

// ── Hidden friends space (separate counters from the couple story limits) ──

/** Friend requests: 50 / day per user. */
export const friendRequestLimiter = make(DAY_MS, 50, 'Bạn đã gửi quá nhiều lời mời kết bạn hôm nay.', true);

/** People search: 60 / min per user (the page searches as you type, debounced). */
export const friendSearchLimiter = make(60_000, 60, 'Bạn tìm kiếm quá nhanh, thử lại sau.', true);

/** Friend posts: 30 / day per user. */
export const friendStoryCreateLimiter = make(DAY_MS, 30, 'Bạn đã đăng quá nhiều bài hôm nay.', true);

/** Friend post photo upload URLs: 100 / day per user (≤ 10 photos per post). */
export const friendStoryUploadLimiter = make(DAY_MS, 100, 'Bạn đã tải quá nhiều ảnh hôm nay.', true);

/** Friend post comments: 120 / hour per user. */
export const friendCommentLimiter = make(60 * 60_000, 120, 'Bạn bình luận quá nhanh, thử lại sau.', true);

/** Blocking: 50 / day per user. */
export const friendBlockLimiter = make(DAY_MS, 50, 'Bạn đã chặn quá nhiều người hôm nay.', true);

/** Reports: 20 / day per user. */
export const friendReportLimiter = make(DAY_MS, 20, 'Bạn đã gửi quá nhiều báo cáo hôm nay.', true);

/** New invite links: 10 / day per user. */
export const friendInviteLimiter = make(DAY_MS, 10, 'Bạn đã tạo quá nhiều link mời hôm nay.', true);

/** "Xóa" on friend suggestions: 100 / day per user (at most 20 are shown at a time). */
export const friendSuggestionDismissLimiter = make(DAY_MS, 100, 'Bạn đã ẩn quá nhiều gợi ý hôm nay.', true);

/** "@" name picker in comments: 60 / min per user (searches as you type, debounced). */
export const friendMentionLimiter = make(60_000, 60, 'Bạn tìm tên quá nhanh, thử lại sau.', true);

/** Poll votes (choose, change, take back): 60 / min per user (BB6). */
export const friendPollVoteLimiter = make(60_000, 60, 'Bạn bình chọn quá nhanh, thử lại sau.', true);

/** Poll voter lists: 60 / min per user (BB6). */
export const friendPollVotersLimiter = make(60_000, 60, 'Thao tác quá nhanh, thử lại sau.', true);

/** New events ("Lên kèo", BB5): 10 / day per user. */
export const friendEventCreateLimiter = make(DAY_MS, 10, 'Hôm nay bạn đã lên 10 kèo rồi. Mai lên tiếp nhé!', true);

/** Event cover upload URLs: 20 / day per user (one cover per event, plus retries). */
export const friendEventUploadLimiter = make(DAY_MS, 20, 'Bạn đã tải quá nhiều ảnh bìa hôm nay.', true);

/** Event edits and cancellations: 30 / day per user (each may notify up to 100 people). */
export const friendEventUpdateLimiter = make(DAY_MS, 30, 'Bạn đã sửa kèo quá nhiều lần hôm nay.', true);

/** "Mời thêm" on an event: 30 / day per user. */
export const friendEventInviteLimiter = make(DAY_MS, 30, 'Bạn đã mời thêm quá nhiều lần hôm nay.', true);

/** Đi · Có thể · Không đi: 60 / min per user. */
export const friendEventRsvpLimiter = make(60_000, 60, 'Bạn đổi câu trả lời quá nhanh, thử lại sau.', true);

/** Public invite-link previews: 20 / 15 min per IP (codes cannot be guessed; this stops scanning). */
export const invitePreviewLimiter = make(15 * 60_000, 20, 'Bạn mở link quá nhiều lần, thử lại sau.', false);

/** Profile photo upload URLs: 20 / day per user. */
export const avatarUploadLimiter = make(DAY_MS, 20, 'Bạn đổi ảnh đại diện quá nhiều lần hôm nay.', true);

// ── Web Push (N4) ──

/** "Gửi thử" a push to this device: 5 / hour per user. */
export const pushTestLimiter = make(60 * 60_000, 5, 'Bạn đã gửi thử 5 lần trong giờ này, thử lại sau nhé.', true);

/** Turning push on (saving a device): 30 / hour per user. */
export const pushSubscribeLimiter = make(60 * 60_000, 30, 'Thao tác quá nhanh, thử lại sau.', true);
