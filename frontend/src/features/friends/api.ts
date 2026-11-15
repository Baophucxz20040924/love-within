import { apiRequest } from '../../lib/apiClient';
import { compressImageWithSize } from '../../lib/image';
import type {
  BlockedFriend,
  FriendComment,
  FriendCommentInput,
  FriendCommentThread,
  FriendEvent,
  FriendEventDetail,
  FriendEventInput,
  FriendInvite,
  FriendListPage,
  FriendNotificationPage,
  FriendPerson,
  FriendProfile,
  FriendStory,
  FriendStoryInput,
  FriendStoryPage,
  FriendSuggestion,
  FriendUser,
  FriendsOverview,
  FriendsUnread,
  InvitePreview,
  JoinResult,
  PollVoters,
  ReportReason,
  ReportTarget,
  RsvpStatus,
  UploadUrlResult,
} from '../../lib/types';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
// Ids and codes come from page URLs (/friends/posts/:id, /j/:code): encode before building API paths.
const enc = encodeURIComponent;

export const friendsApi = {
  overview: () => apiRequest<FriendsOverview>('/friends'),
  unread: () => apiRequest<FriendsUnread>('/friends/unread'),
  search: (q: string) => apiRequest<FriendPerson[]>(`/friends/search?q=${enc(q)}`),
  sendRequest: (userId: string) => apiRequest<FriendPerson>('/friends/requests', { method: 'POST', body: { userId } }),
  accept: (requestId: string) => apiRequest<FriendPerson>(`/friends/requests/${enc(requestId)}/accept`, { method: 'POST' }),
  /** Decline (received) or cancel (sent). */
  removeRequest: (requestId: string) => apiRequest<{ ok: true }>(`/friends/requests/${enc(requestId)}`, { method: 'DELETE' }),
  unfriend: (userId: string) => apiRequest<{ ok: true }>(`/friends/${enc(userId)}`, { method: 'DELETE' }),

  // Suggestions (BB7)
  suggestions: () => apiRequest<FriendSuggestion[]>('/friends/suggestions'),
  /** "Xóa": not suggested again for 90 days. */
  dismissSuggestion: (userId: string) =>
    apiRequest<{ until: string }>(`/friends/suggestions/${enc(userId)}/dismiss`, { method: 'POST' }),

  // Notifications (BB1)
  notifications: (cursor?: string) =>
    apiRequest<FriendNotificationPage>(`/friends/notifications${cursor ? `?cursor=${enc(cursor)}` : ''}`),
  notificationsSeen: () => apiRequest<{ ok: true }>('/friends/notifications/seen', { method: 'POST' }),
  notificationRead: (id: string) => apiRequest<{ ok: true }>(`/friends/notifications/${enc(id)}/read`, { method: 'POST' }),
  notificationsReadAll: () => apiRequest<{ ok: true }>('/friends/notifications/read-all', { method: 'POST' }),

  // Profiles (BB3)
  profile: (userId: string) => apiRequest<FriendProfile>(`/friends/users/${enc(userId)}`),
  userStories: (userId: string, cursor?: string) =>
    apiRequest<FriendStoryPage>(`/friends/users/${enc(userId)}/stories?limit=10${cursor ? `&cursor=${enc(cursor)}` : ''}`),
  userFriends: (userId: string, offset = 0) => apiRequest<FriendListPage>(`/friends/users/${enc(userId)}/friends?offset=${offset}`),
  updateMe: (bio: string) => apiRequest<{ bio: string }>('/friends/me', { method: 'PATCH', body: { bio } }),

  // Safety (BB2)
  blocks: () => apiRequest<BlockedFriend[]>('/friends/blocks'),
  block: (userId: string) => apiRequest<{ ok: true }>('/friends/blocks', { method: 'POST', body: { userId } }),
  unblock: (userId: string) => apiRequest<{ ok: true }>(`/friends/blocks/${enc(userId)}`, { method: 'DELETE' }),
  report: (input: { targetType: ReportTarget; targetId: string; reason: ReportReason; note: string }) =>
    apiRequest<{ hidden: boolean }>('/friends/reports', { method: 'POST', body: input }),

  // Invite links (BB4)
  invites: () => apiRequest<FriendInvite[]>('/friends/invites'),
  createInvite: (days: number, maxUses: number) =>
    apiRequest<FriendInvite>('/friends/invites', { method: 'POST', body: { days, maxUses } }),
  revokeInvite: (id: string) => apiRequest<FriendInvite>(`/friends/invites/${enc(id)}`, { method: 'DELETE' }),
  /** No login needed: what /j/<code> shows. */
  invitePreview: (code: string) => apiRequest<InvitePreview>(`/public/invites/${enc(code)}`, { auth: false }),
  /** Already in the friends space and opening a link: use it right away. */
  join: (inviteCode?: string) =>
    apiRequest<JoinResult>('/friends/join', { method: 'POST', body: inviteCode ? { inviteCode } : {} }),
};

export const friendStoriesApi = {
  feed: (cursor?: string) => apiRequest<FriendStoryPage>(`/friends/stories?limit=10${cursor ? `&cursor=${enc(cursor)}` : ''}`),
  get: (id: string) => apiRequest<FriendStory>(`/friends/stories/${enc(id)}`),
  create: (input: FriendStoryInput) => apiRequest<FriendStory>('/friends/stories', { method: 'POST', body: input }),
  update: (id: string, input: FriendStoryInput) => apiRequest<FriendStory>(`/friends/stories/${enc(id)}`, { method: 'PATCH', body: input }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/friends/stories/${enc(id)}`, { method: 'DELETE' }),
  react: (id: string, type: string) => apiRequest<FriendStory>(`/friends/stories/${enc(id)}/reaction`, { method: 'PUT', body: { type } }),
  unreact: (id: string) => apiRequest<FriendStory>(`/friends/stories/${enc(id)}/reaction`, { method: 'DELETE' }),
  hide: (id: string) => apiRequest<{ ok: true }>(`/friends/stories/${enc(id)}/hide`, { method: 'POST' }),
  comments: (id: string) => apiRequest<FriendCommentThread[]>(`/friends/stories/${enc(id)}/comments`),
  /** A comment, or a reply with parentId (BB8). Mention offsets are relative to the trimmed body. */
  addComment: (id: string, input: FriendCommentInput) =>
    apiRequest<FriendComment>(`/friends/stories/${enc(id)}/comments`, { method: 'POST', body: input }),
  /** removed = 1, or 1 + its replies for a root comment. */
  deleteComment: (id: string, commentId: string) =>
    apiRequest<{ ok: true; removed: number }>(`/friends/stories/${enc(id)}/comments/${enc(commentId)}`, { method: 'DELETE' }),
  /** Draft post picker: accepted, unblocked friends of the author. */
  draftMentionable: (q: string) => apiRequest<FriendUser[]>(`/friends/stories/mentionable?q=${enc(q)}`),
  /** "@" picker: up to 10 people who can see the post. */
  mentionable: (id: string, q: string) => apiRequest<FriendUser[]>(`/friends/stories/${enc(id)}/mentionable?q=${enc(q)}`),
  /** Poll (BB6): my whole choice (one id for a single-choice poll); unvote takes it back. */
  vote: (id: string, optionIds: string[]) =>
    apiRequest<FriendStory>(`/friends/stories/${enc(id)}/vote`, { method: 'PUT', body: { optionIds } }),
  unvote: (id: string) => apiRequest<FriendStory>(`/friends/stories/${enc(id)}/vote`, { method: 'DELETE' }),
  pollVoters: (id: string, optionId: string) =>
    apiRequest<PollVoters>(`/friends/stories/${enc(id)}/poll/voters?option=${enc(optionId)}`),
  uploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/friends/stories/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
};

/** "Lên kèo" (BB5). */
export const friendEventsApi = {
  list: (scope: 'upcoming' | 'past', limit = 50) => apiRequest<{ items: FriendEvent[] }>(`/friends/events?scope=${scope}&limit=${limit}`),
  get: (id: string) => apiRequest<FriendEventDetail>(`/friends/events/${enc(id)}`),
  create: (input: FriendEventInput & { inviteeIds: string[] }) =>
    apiRequest<FriendEventDetail>('/friends/events', { method: 'POST', body: input }),
  /** Only what changed; null clears endAt, mapUrl and cover. */
  update: (id: string, input: Partial<FriendEventInput>) =>
    apiRequest<FriendEventDetail>(`/friends/events/${enc(id)}`, { method: 'PATCH', body: input }),
  invite: (id: string, userIds: string[]) =>
    apiRequest<FriendEventDetail>(`/friends/events/${enc(id)}/invite`, { method: 'POST', body: { userIds } }),
  rsvp: (id: string, status: RsvpStatus) =>
    apiRequest<FriendEventDetail>(`/friends/events/${enc(id)}/rsvp`, { method: 'PUT', body: { status } }),
  cancel: (id: string) => apiRequest<FriendEventDetail>(`/friends/events/${enc(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/friends/events/${enc(id)}`, { method: 'DELETE' }),
  comments: (id: string) => apiRequest<FriendCommentThread[]>(`/friends/events/${enc(id)}/comments`),
  addComment: (id: string, input: FriendCommentInput) =>
    apiRequest<FriendComment>(`/friends/events/${enc(id)}/comments`, { method: 'POST', body: { body: input.body, parentId: input.parentId } }),
  deleteComment: (id: string, commentId: string) =>
    apiRequest<{ ok: true; removed: number }>(`/friends/events/${enc(id)}/comments/${enc(commentId)}`, { method: 'DELETE' }),
  uploadUrl: (mimeType: string, sizeBytes: number) =>
    apiRequest<UploadUrlResult>('/friends/events/upload-url', { method: 'POST', body: { mimeType, sizeBytes } }),
};

/** Compress on the phone (≤ 1600 px JPEG, EXIF/GPS stripped) → presigned URL → PUT straight to storage. */
export async function uploadFriendPhoto(
  file: File,
  getUploadUrl: (mimeType: string, sizeBytes: number) => Promise<UploadUrlResult> = friendStoriesApi.uploadUrl,
): Promise<{ key: string; width: number; height: number }> {
  const { blob, width, height } = await compressImageWithSize(file, 1600, 0.85);
  const mimeType = blob.type || 'image/jpeg';
  if (!ALLOWED.includes(mimeType)) throw new Error('Định dạng ảnh này chưa được hỗ trợ. Hãy chọn ảnh JPEG/PNG.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Ảnh quá lớn (tối đa 5 MB).');
  const { uploadUrl, imageKey } = await getUploadUrl(mimeType, blob.size);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new Error('Tải ảnh lên thất bại. Thử lại nhé.');
  return { key: imageKey, width: width || 1600, height: height || 1200 };
}

// Every key starts with 'friends': invalidating ['friends'] after an action refreshes the whole space.
export const FRIENDS_OVERVIEW_KEY = ['friends', 'overview'] as const;
export const FRIENDS_UNREAD_KEY = ['friends', 'unread'] as const;
export const friendSearchKey = (q: string) => ['friends', 'search', q] as const;
export const FRIEND_FEED_KEY = ['friends', 'feed'] as const;
export const friendStoryKey = (id: string) => ['friends', 'story', id] as const;
export const friendCommentsKey = (id: string) => ['friends', 'comments', id] as const;
export const FRIEND_NOTIFICATIONS_KEY = ['friends', 'notifications'] as const;
export const friendProfileKey = (id: string) => ['friends', 'profile', id] as const;
export const FRIEND_USER_STORIES = ['friends', 'user-stories'] as const;
export const friendUserStoriesKey = (id: string) => [...FRIEND_USER_STORIES, id] as const;
export const friendUserFriendsKey = (id: string) => ['friends', 'user-friends', id] as const;
export const FRIEND_BLOCKS_KEY = ['friends', 'blocks'] as const;
export const FRIEND_INVITES_KEY = ['friends', 'invites'] as const;
export const FRIEND_SUGGESTIONS_KEY = ['friends', 'suggestions'] as const;
export const friendMentionableKey = (storyId: string, q: string) => ['friends', 'mentionable', storyId, q] as const;
export const pollVotersKey = (storyId: string, optionId: string) => ['friends', 'poll-voters', storyId, optionId] as const;
export const FRIEND_EVENTS_KEY = ['friends', 'events'] as const;
export const friendEventsKey = (scope: 'upcoming' | 'past') => [...FRIEND_EVENTS_KEY, scope] as const;
// Shares the mutation-invalidation prefix, never the full-list cache entry.
export const FRIEND_EVENT_STRIP_KEY = [...FRIEND_EVENTS_KEY, 'strip', 'upcoming', 3] as const;
export const friendEventKey = (id: string) => ['friends', 'event', id] as const;
export const friendEventCommentsKey = (id: string) => ['friends', 'event-comments', id] as const;
